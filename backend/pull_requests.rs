//! Read-only GitHub PR context for registered local checkouts. Fetches use private refs;
//! no checkout, push, review submission, merge or agent dispatch happens here.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::path::Path;

fn gh(directory: &Path, executable: &str, args: &[&str]) -> Result<Value> {
    let bytes = crate::process::run(executable, args, Some(directory), vec![])
        .map_err(|e| anyhow::anyhow!("{e}. PR access requires GitHub CLI and gh auth login on this host"))?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn git(directory: &Path, args: &[&str]) -> Result<String> {
    Ok(
        String::from_utf8(crate::process::run("git", args, Some(directory), vec![])?)?
            .trim()
            .into(),
    )
}
/// Lists open PRs or explicitly fetches a selected PR into private refs and resolves its merge base.
/// The checkout and existing local branches remain untouched. GitHub credentials stay with gh.
pub fn route(directory: &Path, executable: &str, method: &str, path: &str, body: Value) -> Result<Value> {
    if method == "GET" && path == "/api/prs" {
        return gh(
            directory,
            executable,
            &[
                "pr",
                "list",
                "--limit",
                "50",
                "--json",
                "number,title,url,author,isDraft,baseRefName,headRefName,updatedAt",
            ],
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
        &[
            "pr",
            "view",
            &number,
            "--json",
            "number,title,url,body,baseRefName,baseRefOid,headRefName,headRefOid,comments,reviews,statusCheckRollup",
        ],
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
    let credential = format!("credential.https://github.com.helper=!'{command}' auth git-credential");
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
    if pr["headRefOid"].as_str() != Some(head.as_str())
        || pr["baseRefOid"].as_str() != Some(base_tip.as_str())
    {
        bail!("PR changed during fetch. Open it again to inspect the latest version");
    }
    let merge_base = git(directory, &["merge-base", &base_ref, &head_ref])
        .context("Cannot find PR merge base; this checkout may need more Git history")?;
    Ok(json!({"pr": pr, "base": merge_base, "head": head}))
}
