//! Image skill targets are independent of provider/MCP application types.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImagegenTarget {
    Claude,
    Codex,
    Gemini,
    GrokBuild,
    OpenCode,
    Hermes,
    Dsh,
    WorkBuddy,
}

impl ImagegenTarget {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" | "chatgpt-desktop" => Ok(Self::Codex),
            "gemini" => Ok(Self::Gemini),
            "grokbuild" => Ok(Self::GrokBuild),
            "opencode" => Ok(Self::OpenCode),
            "hermes" => Ok(Self::Hermes),
            "dsh" => Ok(Self::Dsh),
            "workbuddy" => Ok(Self::WorkBuddy),
            _ => Err(anyhow!(
                "This application does not support the image skill: {value}"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::GrokBuild => "grokbuild",
            Self::OpenCode => "opencode",
            Self::Hermes => "hermes",
            Self::Dsh => "dsh",
            Self::WorkBuddy => "workbuddy",
        }
    }

    pub fn all() -> [Self; 8] {
        [
            Self::Claude,
            Self::Codex,
            Self::Gemini,
            Self::GrokBuild,
            Self::OpenCode,
            Self::Hermes,
            Self::Dsh,
            Self::WorkBuddy,
        ]
    }

    pub fn core_app(self) -> Option<AppType> {
        match self {
            Self::Claude => Some(AppType::Claude),
            Self::Codex => Some(AppType::Codex),
            Self::Gemini => Some(AppType::Gemini),
            Self::GrokBuild => Some(AppType::GrokBuild),
            Self::OpenCode => Some(AppType::OpenCode),
            Self::Hermes => Some(AppType::Hermes),
            Self::Dsh | Self::WorkBuddy => None,
        }
    }

    pub fn skills_dir(self) -> Result<PathBuf> {
        match self {
            Self::Dsh => Ok(crate::commands::dsh_install::home().join("skills")),
            Self::WorkBuddy => Ok(crate::config::get_home_dir().join(".codebuddy/skills")),
            _ => SkillService::get_app_skills_dir(&self.core_app().expect("core target")),
        }
    }

    pub fn projection_path(self) -> Result<PathBuf> {
        Ok(self.skills_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY))
    }

    pub fn runtime_path(self) -> Result<PathBuf> {
        let path = get_app_config_dir()
            .join("imagegen")
            .join(format!("{}.json", self.as_str()));
        if !path.is_absolute() {
            return Err(anyhow!("Image skill runtime path must be absolute"));
        }
        Ok(path)
    }

    pub fn is_enabled(self, apps: &SkillApps) -> bool {
        match self {
            Self::Dsh => apps.dsh,
            Self::WorkBuddy => apps.workbuddy,
            _ => apps.is_enabled_for(&self.core_app().expect("core target")),
        }
    }

    pub fn set_enabled(self, apps: &mut SkillApps, enabled: bool) {
        match self {
            Self::Dsh => apps.dsh = enabled,
            Self::WorkBuddy => apps.workbuddy = enabled,
            _ => apps.set_enabled_for(&self.core_app().expect("core target"), enabled),
        }
    }

    pub fn enabled_targets(apps: &SkillApps) -> Vec<Self> {
        Self::all()
            .into_iter()
            .filter(|target| target.is_enabled(apps))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_preserve_core_app_boundary_and_legacy_skill_apps() {
        assert_eq!(
            ImagegenTarget::parse("chatgpt-desktop").unwrap(),
            ImagegenTarget::Codex
        );
        assert!(ImagegenTarget::Dsh.core_app().is_none());
        assert!(ImagegenTarget::WorkBuddy.core_app().is_none());
        assert!(ImagegenTarget::parse("claude-desktop").is_err());
        let mut apps: SkillApps = serde_json::from_str(r#"{"codex":true}"#).unwrap();
        assert!(!apps.dsh && !apps.workbuddy);
        ImagegenTarget::Dsh.set_enabled(&mut apps, true);
        assert_eq!(
            ImagegenTarget::enabled_targets(&apps),
            vec![ImagegenTarget::Codex, ImagegenTarget::Dsh]
        );
        apps.codex = false;
        assert!(!apps.is_empty());
    }
}
