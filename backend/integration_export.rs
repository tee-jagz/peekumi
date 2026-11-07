//! Bounded snapshot exports and private source copies for trusted analysis tools.
use super::*;
use base64::Engine as _;

const MAX_BYTES: usize = 64 * 1024 * 1024;
type ExportFiles = (Vec<(String, Vec<u8>, bool)>, Vec<String>);

/// A newly created private folder. Dropping it removes only this analysis copy.
pub(super) struct PrivateCopy(pub PathBuf);
impl Drop for PrivateCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn excluded(path: &str) -> bool {
    restricted(path)
        || path
            .split('/')
            .any(|p| [".git", "__pycache__", ".pytest_cache", ".metrics"].contains(&p))
        || path
            .rsplit('/')
            .next()
            .is_some_and(|p| p.starts_with(".coverage") || p == "lcov.info" || p.ends_with(".pyc"))
}

impl Repository {
    /// Reads eligible regular files through the snapshot object's alternate environment.
    /// Unsafe links, restricted files and old measurement files are excluded with reasons.
    fn export_files(&self, snapshot: &Snapshot) -> Result<ExportFiles> {
        anyhow::ensure!(
            snapshot.files.len() <= 5000,
            "Snapshot export exceeds 5000 files"
        );
        let mut files = vec![];
        let mut limits = vec![];
        let mut total = 0;
        for file in snapshot.files.values() {
            if excluded(&file.path) || !["100644", "100755"].contains(&file.mode.as_str()) {
                limits.push(format!(
                    "Export omitted {}: restricted, link, submodule or prior measurement data",
                    file.path
                ));
                continue;
            }
            anyhow::ensure!(
                Path::new(&file.path)
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))),
                "Unsafe snapshot path"
            );
            total += file.size as usize;
            anyhow::ensure!(total <= MAX_BYTES, "Snapshot export exceeds 64 MiB");
            let bytes = self.git(&["cat-file", "blob", &file.oid])?;
            files.push((file.path.clone(), bytes, file.mode == "100755"));
        }
        Ok((files, limits))
    }

    /// Materializes regular snapshot files in private state. It never executes source.
    pub(super) fn private_copy(&self, snapshot: &Snapshot) -> Result<(PrivateCopy, Vec<String>)> {
        let parent = self.state.join("integration-analysis");
        std::fs::create_dir_all(&parent)?;
        let folder = PrivateCopy(parent.join(crate::random_token()));
        std::fs::create_dir(&folder.0)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&folder.0, std::fs::Permissions::from_mode(0o700))?;
        }
        let (files, limits) = self.export_files(snapshot)?;
        for (path, bytes, _) in files {
            let destination = folder.0.join(path);
            std::fs::create_dir_all(destination.parent().unwrap())?;
            std::fs::write(destination, bytes)?;
        }
        Ok((folder, limits))
    }

    /// Exports only a revision that belongs to the requested active baseline.
    pub fn integration_export(&mut self, baseline: &str, sha: &str) -> Result<Value> {
        let start = crate::worktree::get_baseline(&self.state, baseline)?;
        anyhow::ensure!(
            sha == start.sha || start.snapshots.contains(sha),
            "Snapshot does not belong to this baseline"
        );
        let snapshot = self.snapshot(sha)?;
        let (files, mut limits) = self.export_files(&snapshot)?;
        let mut archive = vec![];
        for (path, bytes, executable) in files {
            if !append_tar(&mut archive, &path, &bytes, executable) {
                limits.push(format!("Export omitted {path}: path exceeds USTAR limits"));
            }
        }
        archive.extend_from_slice(&[0; 1024]);
        anyhow::ensure!(archive.len() <= MAX_BYTES, "Tar export exceeds 64 MiB");
        let run = crate::integration_evidence::reserve(&self.state, baseline, sha)?;
        Ok(json!({"status":"incomplete","limits":limits,
            "snapshot":sha,"run_id":run,"archive":base64::engine::general_purpose::STANDARD.encode(archive)}))
    }
}

fn octal(destination: &mut [u8], value: usize) {
    let encoded = format!("{value:0width$o}\0", width = destination.len() - 1);
    destination.copy_from_slice(encoded.as_bytes());
}

fn append_tar(output: &mut Vec<u8>, path: &str, data: &[u8], executable: bool) -> bool {
    let (prefix, name) = if path.len() <= 100 {
        ("", path)
    } else {
        let Some((prefix, name)) = path.rsplit_once('/') else {
            return false;
        };
        if prefix.len() > 155 || name.len() > 100 {
            return false;
        }
        (prefix, name)
    };
    let mut header = [0u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    octal(
        &mut header[100..108],
        if executable { 0o755 } else { 0o644 },
    );
    octal(&mut header[108..116], 0);
    octal(&mut header[116..124], 0);
    octal(&mut header[124..136], data.len());
    octal(&mut header[136..148], 0);
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    let checksum: usize = header.iter().map(|b| *b as usize).sum();
    let checksum = format!("{checksum:06o}\0 ");
    header[148..156].copy_from_slice(checksum.as_bytes());
    output.extend_from_slice(&header);
    output.extend_from_slice(data);
    output.resize(output.len() + (512 - data.len() % 512) % 512, 0);
    true
}
