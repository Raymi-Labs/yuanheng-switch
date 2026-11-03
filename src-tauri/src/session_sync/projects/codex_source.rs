//! 只读读取 Codex Desktop 的项目分组：`state_5.sqlite` 的 `projects` + `project_roots`。
//! 只读打开，不写 Codex 的数据库。

use rusqlite::{Connection, OpenFlags};

use super::SourceProject;
use crate::session_sync::normalize_project_dir;

fn state_db_paths() -> Vec<std::path::PathBuf> {
    let config_dir = crate::codex_config::get_codex_config_dir();
    let config_text = crate::codex_config::read_codex_config_text().unwrap_or_default();
    crate::codex_state_db::codex_state_db_paths(&config_dir, &config_text)
}

pub fn read_projects() -> Vec<SourceProject> {
    for path in state_db_paths() {
        if !path.exists() {
            continue;
        }
        match read_projects_from(&path) {
            Ok(projects) if !projects.is_empty() => return projects,
            Ok(_) => continue,
            Err(e) => log::warn!("[project-sync] 读取 Codex 项目失败 {}: {e}", path.display()),
        }
    }
    Vec::new()
}

pub fn read_projects_from(path: &std::path::Path) -> Result<Vec<SourceProject>, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let has_tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('projects','project_roots')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_tables < 2 {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, p.position, r.path
             FROM projects p JOIN project_roots r ON r.project_id = p.id
             ORDER BY p.position ASC, p.id ASC, r.position ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<(String, SourceProject)> = Vec::new();
    for row in rows.flatten() {
        let (id, name, position, root) = row;
        let root = normalize_project_dir(&root);
        if root.is_empty() {
            continue;
        }
        match out.iter_mut().find(|(pid, _)| *pid == id) {
            Some((_, project)) => {
                if !project.roots.contains(&root) {
                    project.roots.push(root);
                }
            }
            None => out.push((
                id,
                SourceProject {
                    source_provider: "codex".into(),
                    name: name.trim().to_string(),
                    position,
                    roots: vec![root],
                },
            )),
        }
    }
    Ok(out.into_iter().map(|(_, p)| p).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_roots_per_project_in_position_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state_5.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
             CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position));
             INSERT INTO projects VALUES ('b','后端','{}',1,0,0), ('a','前端','{}',0,0,0);
             INSERT INTO project_roots VALUES ('a',0,'/nonexistent/web/'), ('b',0,'/nonexistent/api'), ('b',1,'/nonexistent/worker');",
        )
        .unwrap();
        drop(conn);
        let projects = read_projects_from(&path).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].name, "前端");
        assert_eq!(projects[0].roots, vec!["/nonexistent/web"]);
        assert_eq!(
            projects[1].roots,
            vec!["/nonexistent/api", "/nonexistent/worker"]
        );
    }

    #[test]
    fn missing_tables_yield_no_projects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state_5.sqlite");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE threads (id TEXT)")
            .unwrap();
        assert!(read_projects_from(&path).unwrap().is_empty());
    }
}
