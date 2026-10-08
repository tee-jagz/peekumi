//! Web Push: a notification on the owner's phone when an agent finishes work, also while the
//! app is closed.
//!
//! A device that turns notifications on sends its push subscription (the push service's
//! endpoint and the device's keys). The server keeps the subscriptions and a VAPID key pair in
//! its private folder, which every repository shares. To notify, it encrypts the message for
//! each device as RFC 8291 specifies (`aes128gcm`), signs a VAPID token (RFC 8292) and posts the
//! message to the push service with `curl`. The push service (Apple, Google, Mozilla or
//! Microsoft) carries the message but cannot read it. A device's service worker shows it only
//! when no Peekumi window is open on the screen.
//!
//! Only the endpoints of known push services are accepted, so a device cannot make the server
//! send requests to other places. A subscription that the push service says is gone (404 or
//! 410) is removed.
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::sec1::ToEncodedPoint,
};
use serde_json::{Value, json};
use sha2::Sha256;
use std::path::{Path, PathBuf};

/// The hosts of the push services that browsers use.
const PUSH_HOSTS: [&str; 4] = [
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
];
/// The most devices that can receive notifications.
const MAX_DEVICES: usize = 20;
/// The record size in the `aes128gcm` header. One record holds a whole message.
const RECORD: u32 = 4096;

fn folder(secrets: &Path) -> PathBuf {
    secrets.join("push")
}

/// Writes `bytes` to `path` so that only this user can read it.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().context("No folder")?;
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let partial = path.with_extension("partial");
    std::fs::write(&partial, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(partial, path)?;
    Ok(())
}

/// A new random P-256 secret key.
fn random_key() -> SecretKey {
    loop {
        if let Ok(key) = SecretKey::from_slice(&rand::random::<[u8; 32]>()) {
            return key;
        }
    }
}

/// The server's VAPID key, made the first time it is needed.
fn vapid_key(secrets: &Path) -> Result<SigningKey> {
    let path = folder(secrets).join("vapid.key");
    if let Ok(saved) = std::fs::read_to_string(&path) {
        let bytes = B64
            .decode(saved.trim())
            .context("The VAPID key is damaged")?;
        return Ok(SigningKey::from_slice(&bytes)?);
    }
    let key = random_key();
    write_private(&path, B64.encode(key.to_bytes()).as_bytes())?;
    Ok(SigningKey::from(key))
}

/// The VAPID public key that devices subscribe with (base64url, uncompressed point).
pub fn public_key(secrets: &Path) -> Result<String> {
    let key = vapid_key(secrets)?;
    Ok(B64.encode(key.verifying_key().to_encoded_point(false).as_bytes()))
}

/// Encrypts `payload` for a device (RFC 8291, `aes128gcm`): with the device's public key
/// `ua_public` (65 bytes) and authentication secret `auth` (16 bytes), the sender's one-time
/// key `sender` and `salt`. Returns the message body: the header, then the one record.
pub fn encrypt(
    payload: &[u8],
    ua_public: &[u8],
    auth: &[u8],
    sender: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>> {
    use aes_gcm::{Aes128Gcm, KeyInit, Nonce, aead::Aead};
    ensure!(
        payload.len() + 17 <= RECORD as usize,
        "The message is too long"
    );
    let device = PublicKey::from_sec1_bytes(ua_public).context("The device key is invalid")?;
    let sender_public = sender.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(sender.to_nonzero_scalar(), device.as_affine());
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(ua_public);
    info.extend_from_slice(sender_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
        .expand(&info, &mut ikm)
        .map_err(|_| anyhow::anyhow!("Key derivation failed"))?;
    let keys = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    keys.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .and_then(|_| keys.expand(b"Content-Encoding: nonce\0", &mut nonce))
        .map_err(|_| anyhow::anyhow!("Key derivation failed"))?;
    // The last (and only) record ends with the delimiter 2.
    let mut plain = payload.to_vec();
    plain.push(2);
    let sealed = Aes128Gcm::new_from_slice(&cek)?
        .encrypt(Nonce::from_slice(&nonce), plain.as_ref())
        .map_err(|_| anyhow::anyhow!("Encryption failed"))?;
    let mut body = salt.to_vec();
    body.extend_from_slice(&RECORD.to_be_bytes());
    body.push(65);
    body.extend_from_slice(sender_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// The `Authorization` header for `endpoint` (RFC 8292): a token that the server's VAPID key
/// signs, valid for 12 hours, and the public key.
fn vapid_header(secrets: &Path, endpoint: &str) -> Result<String> {
    let key = vapid_key(secrets)?;
    let url = url::Url::parse(endpoint)?;
    let audience = url.origin().ascii_serialization();
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        + 12 * 3600;
    let header = B64.encode(json!({"typ": "JWT", "alg": "ES256"}).to_string());
    let claims = B64.encode(
        json!({"aud": audience, "exp": expires, "sub": "https://github.com/tee-jagz/peekumi"})
            .to_string(),
    );
    let signed = format!("{header}.{claims}");
    let signature: Signature = key.sign(signed.as_bytes());
    Ok(format!(
        "vapid t={signed}.{}, k={}",
        B64.encode(signature.to_bytes()),
        B64.encode(key.verifying_key().to_encoded_point(false).as_bytes())
    ))
}

/// True when `endpoint` is a push service that browsers use. `PEEKUMI_PUSH_TEST_ORIGIN` adds one
/// more origin, for tests.
fn allowed(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else {
        return false;
    };
    if let Ok(test) = std::env::var("PEEKUMI_PUSH_TEST_ORIGIN")
        && !test.is_empty()
        && url.origin().ascii_serialization() == test
    {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && url.port().is_none()
        && (PUSH_HOSTS.contains(&host) || host.ends_with(".notify.windows.com"))
}

fn subscriptions_file(secrets: &Path) -> PathBuf {
    folder(secrets).join("subscriptions.json")
}

/// The saved subscriptions: `[{endpoint, p256dh, auth, added}]`.
pub fn subscriptions(secrets: &Path) -> Vec<Value> {
    std::fs::read(subscriptions_file(secrets))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
        .unwrap_or_default()
}

fn save(secrets: &Path, list: &[Value]) -> Result<()> {
    write_private(&subscriptions_file(secrets), &serde_json::to_vec(list)?)
}

/// Saves a browser's push subscription (`{endpoint, keys: {p256dh, auth}}`), in place of an
/// earlier one with the same endpoint.
pub fn subscribe(secrets: &Path, subscription: &Value) -> Result<()> {
    let endpoint = subscription["endpoint"]
        .as_str()
        .filter(|e| e.len() <= 2000)
        .context("The subscription has no endpoint")?;
    if !allowed(endpoint) {
        bail!("This push service is not supported");
    }
    let p256dh = subscription["keys"]["p256dh"].as_str().unwrap_or("");
    let auth = subscription["keys"]["auth"].as_str().unwrap_or("");
    let device = B64
        .decode(p256dh.trim_end_matches('='))
        .context("The device key is invalid")?;
    PublicKey::from_sec1_bytes(&device).context("The device key is invalid")?;
    ensure!(
        B64.decode(auth.trim_end_matches('='))
            .is_ok_and(|a| a.len() == 16),
        "The device secret is invalid"
    );
    let mut list = subscriptions(secrets);
    list.retain(|s| s["endpoint"] != endpoint);
    list.push(json!({"endpoint": endpoint, "p256dh": p256dh.trim_end_matches('='), "auth": auth.trim_end_matches('='), "added": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()}));
    // The oldest devices go first when there are too many.
    let extra = list.len().saturating_sub(MAX_DEVICES);
    list.drain(..extra);
    save(secrets, &list)
}

/// Removes the subscription with `endpoint`.
pub fn unsubscribe(secrets: &Path, endpoint: &str) -> Result<()> {
    let mut list = subscriptions(secrets);
    list.retain(|s| s["endpoint"] != endpoint);
    save(secrets, &list)
}

/// Sends `message` (`{title, body, url, tag}`) to one subscription. Returns the HTTP status.
fn send(secrets: &Path, subscription: &Value, message: &Value) -> Result<u16> {
    let endpoint = subscription["endpoint"].as_str().unwrap_or("");
    ensure!(allowed(endpoint), "This push service is not supported");
    let device = B64.decode(subscription["p256dh"].as_str().unwrap_or(""))?;
    let auth = B64.decode(subscription["auth"].as_str().unwrap_or(""))?;
    let body = encrypt(
        message.to_string().as_bytes(),
        &device,
        &auth,
        &random_key(),
        &rand::random::<[u8; 16]>(),
    )?;
    let authorization = format!("Authorization: {}", vapid_header(secrets, endpoint)?);
    let out = crate::process::run_for(
        "curl",
        &[
            "--silent",
            "--show-error",
            "--max-time",
            "15",
            "-X",
            "POST",
            "-H",
            "TTL: 86400",
            "-H",
            "Urgency: high",
            "-H",
            "Content-Encoding: aes128gcm",
            "-H",
            "Content-Type: application/octet-stream",
            "-H",
            &authorization,
            "--data-binary",
            "@-",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--",
            endpoint,
        ],
        None,
        body,
        std::time::Duration::from_secs(20),
    )?;
    Ok(String::from_utf8_lossy(&out).trim().parse().unwrap_or(0))
}

/// Notifies every subscribed device, in the background: `message` is `{title, body, url,
/// tag}`. A device that the push service no longer knows is removed. Errors stay here: a
/// notification that fails never stops the work that sent it.
pub fn notify(secrets: &Path, message: Value) {
    let secrets = secrets.to_path_buf();
    std::thread::spawn(move || {
        let list = subscriptions(&secrets);
        let mut gone = vec![];
        for subscription in &list {
            if let Ok(404 | 410) = send(&secrets, subscription, &message) {
                gone.push(subscription["endpoint"].clone());
            }
        }
        if !gone.is_empty() {
            let mut list = subscriptions(&secrets);
            list.retain(|s| !gone.contains(&s["endpoint"]));
            let _ = save(&secrets, &list);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example of RFC 8291, appendix A: the same keys, salt and message give the same bytes.
    #[test]
    fn encrypts_as_rfc_8291_specifies() {
        let decode = |s: &str| B64.decode(s).unwrap();
        let sender =
            SecretKey::from_slice(&decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        assert_eq!(
            B64.encode(sender.public_key().to_encoded_point(false).as_bytes()),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        let salt: [u8; 16] = decode("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt(
            b"When I grow up, I want to be a watermelon",
            &decode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            &decode("BTBZMqHH6r4Tts7J_aSIgg"),
            &sender,
            &salt,
        )
        .unwrap();
        assert_eq!(
            B64.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn only_push_services_are_accepted() {
        assert!(allowed("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(allowed("https://web.push.apple.com/QK2"));
        assert!(allowed("https://wns2-db5p.notify.windows.com/w/?token=x"));
        assert!(!allowed("http://fcm.googleapis.com/fcm/send/abc"));
        assert!(!allowed("https://fcm.googleapis.com:8443/x"));
        assert!(!allowed("https://evil.example/fcm.googleapis.com"));
        assert!(!allowed("https://169.254.169.254/latest"));
    }
}
