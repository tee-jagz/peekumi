//! Read-only GitHub PR context for registered local checkouts. Fetches use private refs;
//! no checkout, push, review submission, merge or agent dispatch happens here.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::path::Path;

/// The PR details the sheet shows: what it is, who made it, its size, checks and reviews.
const VIEW_FIELDS: &str = "number,title,url,state,isDraft,body,author,createdAt,mergedAt,closedAt,\
additions,deletions,changedFiles,baseRefName,baseRefOid,headRefName,headRefOid,comments,reviews,\
statusCheckRollup";

fn gh(directory: &Path, executable: &str, args: &[&str]) -> Result<Value> {
    let bytes = crate::process::run(executable, args, Some(directory), vec![])
        // The command's own path and output stay off the screen.
        .map_err(|_| anyhow::anyhow!("Peekumi cannot read pull requests. Install the GitHub CLI (gh) on this computer and run gh auth login"))?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn git(directory: &Path, args: &[&str]) -> Result<String> {
    Ok(
        String::from_utf8(crate::process::run("git", args, Some(directory), vec![])?)?
            .trim()
            .into(),
    )
}
/// Lists open and recently merged PRs, reads one PR's details, or explicitly fetches a selected PR into private refs
/// and resolves its merge base. An open PR is compared with its base branch now; a merged or
/// closed PR with the base it had, which shows exactly what it changed. The checkout and
/// existing local branches remain untouched. GitHub credentials stay with gh.
pub fn route(
    directory: &Path,
    executable: &str,
    method: &str,
    path: &str,
    body: Value,
) -> Result<Value> {
    if method == "GET" && path == "/api/prs" {
        return gh(
            directory,
            executable,
            &[
                "pr",
                "list",
                "--state",
                "all",
                "--limit",
                "50",
                "--json",
                "number,title,url,author,isDraft,state,baseRefName,headRefName,createdAt,mergedAt,updatedAt",
            ],
        );
    }
    // `GET /api/prs/<number>` reads one PR's details again (after a reload) without a fetch.
    if method == "GET" {
        let number = path
            .strip_prefix("/api/prs/")
            .and_then(|n| n.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .context("Unsupported PR operation")?
            .to_string();
        return gh(
            directory,
            executable,
            &["pr", "view", &number, "--json", VIEW_FIELDS],
        );
    }
    ensure!(
        method == "POST" && path == "/api/prs/open",
        "Unsupported PR operation"
    );
    let number = body["number"]
        .as_u64()
        .filter(|n| *n > 0)
        .context("A positive PR number is required")?
        .to_string();
    let pr = gh(
        directory,
        executable,
        &["pr", "view", &number, "--json", VIEW_FIELDS],
    )?;
    let repo = gh(directory, executable, &["repo", "view", "--json", "url"])?;
    let remote = repo["url"]
        .as_str()
        .context("Missing GitHub repository URL")?;
    let parsed = url::Url::parse(remote)?;
    ensure!(
        parsed.scheme() == "https" && parsed.host_str() == Some("github.com"),
        "Only github.com PRs are supported initially"
    );
    let base = pr["baseRefName"].as_str().context("Missing base branch")?;
    let head_ref = format!("refs/peekumi/pr/{number}/head");
    let base_ref = format!("refs/peekumi/pr/{number}/base");
    // Use gh's credential helper only for this fetch; never write repository Git configuration.
    let command = executable.replace('\'', "'\\''");
    let credential =
        format!("credential.https://github.com.helper=!'{command}' auth git-credential");
    git(
        directory,
        &[
            "-c",
            "credential.helper=",
            "-c",
            &credential,
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            remote,
            &format!("+refs/pull/{number}/head:{head_ref}"),
            &format!("+refs/heads/{base}:{base_ref}"),
        ],
    )?;
    let head = git(directory, &["rev-parse", "--verify", &head_ref])?;
    let base_tip = git(directory, &["rev-parse", "--verify", &base_ref])?;
    // For an open PR, GitHub's base is the base branch now, so both must match what was
    // fetched. A merged or closed PR keeps the base it had, which the base branch contains.
    let open = !["MERGED", "CLOSED"].contains(&pr["state"].as_str().unwrap_or("OPEN"));
    ensure!(
        pr["headRefOid"].as_str() == Some(head.as_str())
            && (!open || pr["baseRefOid"].as_str() == Some(base_tip.as_str())),
        "PR changed during fetch. Open it again to inspect the latest version"
    );
    let recorded = pr["baseRefOid"].as_str().filter(|sha| {
        !open
            && sha.len() == 40
            && sha.bytes().all(|b| b.is_ascii_hexdigit())
            && git(directory, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok()
    });
    let compare_from = recorded.map(str::to_string).unwrap_or(base_ref.clone());
    let merge_base = git(directory, &["merge-base", &compare_from, &head_ref])
        .context("Cannot find PR merge base; this checkout may need more Git history")?;
    Ok(json!({"pr": pr, "base": merge_base, "head": head}))
}
