//! Repository-scoped integration credentials. Only token hashes reach private state.
//! HTTP reloads the registry on each request, so revocation needs no service restart.
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize, Serialize)]
pub struct Grant {
    pub name: String,
    pub repository: String,
    digest: String,
}

fn read(state: &Path) -> Result<BTreeMap<String, Grant>> {
    match std::fs::read(state.join("integration-tokens.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
}

fn save(state: &Path, grants: &BTreeMap<String, Grant>) -> Result<()> {
    let pending = state.join("integration-tokens.pending");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&pending)?;
    file.write_all(&serde_json::to_vec(grants)?)?;
    file.sync_all()?;
    std::fs::rename(pending, state.join("integration-tokens.json"))?;
    Ok(())
}

/// Looks up a bearer with the existing constant-time comparison. No secret is logged.
/// Corrupt or unreadable state returns an error rather than granting access.
pub fn authenticate(state: &Path, bearer: &str) -> Result<Option<Grant>> {
    if !bearer.starts_with("pki_") || bearer.len() != 68 {
        return Ok(None);
    }
    let digest = crate::hash::hash(bearer);
    Ok(read(state)?
        .into_values()
        .find(|g| crate::equal(&digest, &g.digest)))
}

/// The full method and route allowlist. Other APIs and checkout writes are excluded.
pub fn allows(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        (
            "POST",
            "/api/integrations/baseline" | "/api/integrations/coverage"
        ) | (
            "GET",
            "/api/integrations/export" | "/api/integrations/impact" | "/api/integrations/map"
        )
    )
}

#[derive(Parser)]
struct Options {
    #[arg(long)]
    state_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        repo: String,
    },
    List,
    Revoke {
        name: String,
    },
}

/// Runs `peekumi token` for the management command. Creation prints a secret once.
/// Registry errors and duplicate names stop before any credential is changed.
pub fn command() -> Result<()> {
    let options = Options::parse_from(
        std::iter::once("peekumi token".to_string()).chain(std::env::args().skip(2)),
    );
    let state = options.state_dir;
    std::fs::create_dir_all(&state)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join("integration-tokens.lock"))?;
    lock.lock()?;
    let mut grants = read(&state)?;
    match options.command {
        Command::Create { name, repo } => {
            ensure!(
                !name.is_empty()
                    && name.len() <= 64
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "Use a token name with letters, digits, - or _"
            );
            ensure!(
                !grants.contains_key(&name),
                "Token name already exists; revoke it first"
            );
            let config: serde_json::Value =
                serde_json::from_slice(&std::fs::read(state.join("config.json"))?)?;
            ensure!(config["version"] == 1, "Unsupported config version");
            let repositories = config["repositories"]
                .as_array()
                .context("Missing registered repositories")?;
            let matches: Vec<_> = repositories
                .iter()
                .filter_map(|v| v.as_str())
                .filter_map(|p| {
                    let path = Path::new(p).canonicalize().ok()?;
                    let id = crate::repository_id(&path);
                    (repo == p
                        || repo == id
                        || path.file_name().is_some_and(|n| n == repo.as_str()))
                    .then_some(id)
                })
                .collect();
            ensure!(
                matches.len() == 1,
                "Repository name is absent or ambiguous; use a registered path or ID"
            );
            let token = format!("pki_{}", crate::random_token());
            grants.insert(
                name.clone(),
                Grant {
                    name,
                    repository: matches[0].clone(),
                    digest: crate::hash::hash(&token),
                },
            );
            save(&state, &grants)?;
            println!("{token}");
        }
        Command::List => println!(
            "{}",
            serde_json::to_string(
                &grants
                    .values()
                    .map(|g| serde_json::json!({"name":g.name,"repository":g.repository}))
                    .collect::<Vec<_>>()
            )?
        ),
        Command::Revoke { name } => {
            ensure!(grants.remove(&name).is_some(), "Token name does not exist");
            save(&state, &grants)?;
            println!("Revoked {name}");
        }
    }
    Ok(())
}
