//! SHA-256 fingerprints shared by the analysis, workflow and HTTP layers.
use sha2::{Digest, Sha256};

/// Computes a hexadecimal SHA-256 fingerprint for cache namespaces, parser versions and symbol identities.
pub fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data))
}
