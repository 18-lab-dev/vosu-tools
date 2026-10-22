use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy)]
struct Property {
    name: &'static str,
    kind: &'static str,
    target: Option<&'static str>,
    array: bool,
    nullable: bool,
    required: bool,
}
const fn scalar(
    name: &'static str,
    kind: &'static str,
    required: bool,
    nullable: bool,
) -> Property {
    Property {
        name,
        kind,
        target: None,
        array: false,
        nullable,
        required,
    }
}
const fn link(name: &'static str, target: &'static str, array: bool, required: bool) -> Property {
    Property {
        name,
        kind: "object",
        target: Some(target),
        array,
        nullable: !array,
        required,
    }
}
// Only fields consumed by v1 are constrained. Unknown classes/properties are ignored.
const MODELS: &[(&str, &[Property])] = &[
    ("metadata", &[scalar("version", "int", true, false)]),
    (
        "class_BeatmapSet",
        &[
            scalar("ID", "uuid", true, false),
            scalar("OnlineID", "int", false, true),
            link("Files", "class_RealmNamedFileUsage", true, true),
            scalar("DeletePending", "bool", false, true),
        ],
    ),
    (
        "class_Beatmap",
        &[
            scalar("ID", "uuid", false, true),
            scalar("MD5Hash", "string", true, true),
            scalar("Hash", "string", true, true),
            link("BeatmapSet", "class_BeatmapSet", false, true),
            link("Ruleset", "class_Ruleset", false, true),
            link("Metadata", "class_BeatmapMetadata", false, false),
            scalar("OnlineID", "int", false, true),
            scalar("DifficultyName", "string", false, true),
        ],
    ),
    (
        "class_RealmNamedFileUsage",
        &[
            scalar("Filename", "string", true, true),
            link("File", "class_File", false, true),
        ],
    ),
    ("class_File", &[scalar("Hash", "string", true, true)]),
    (
        "class_Ruleset",
        &[scalar("ShortName", "string", true, true)],
    ),
    (
        "class_Skin",
        &[
            scalar("ID", "uuid", true, false),
            link("Files", "class_RealmNamedFileUsage", true, true),
            scalar("Name", "string", false, true),
            scalar("Creator", "string", false, true),
            scalar("DeletePending", "bool", false, true),
        ],
    ),
    (
        "class_Score",
        &[
            scalar("ID", "uuid", false, true),
            scalar("BeatmapHash", "string", true, true),
            link("Files", "class_RealmNamedFileUsage", true, false),
            link("User", "class_RealmUser", false, false),
            link("Ruleset", "class_Ruleset", false, false),
            scalar("Mods", "string", false, true),
            scalar("TotalScore", "int", false, true),
            scalar("Date", "timestamp", false, true),
            scalar("DeletePending", "bool", false, true),
        ],
    ),
    (
        "class_BeatmapMetadata",
        &[
            scalar("Artist", "string", false, true),
            scalar("Title", "string", false, true),
            link("Author", "class_RealmUser", false, false),
            scalar("AudioFile", "string", false, true),
            scalar("BackgroundFile", "string", false, true),
        ],
    ),
    (
        "class_RealmUser",
        &[scalar("Username", "string", false, true)],
    ),
];

#[derive(Debug)]
pub struct Compatibility {
    pub missing: Vec<String>,
    pub errors: Vec<String>,
    invalid_optional: HashMap<&'static str, Vec<&'static str>>,
}
pub fn inspect(schemas: &[Value]) -> Compatibility {
    let mut result = Compatibility {
        missing: vec![],
        errors: vec![],
        invalid_optional: HashMap::new(),
    };
    for &(class, properties) in MODELS {
        let model = schemas.iter().find(|v| v["name"].as_str() == Some(class));
        for property in properties {
            let found = model
                .and_then(|v| v["properties"].as_array())
                .and_then(|ps| {
                    ps.iter()
                        .find(|p| p["name"].as_str() == Some(property.name))
                });
            let problem = match found {
                None => Some("missing property".to_owned()),
                Some(p)
                    if p["type"].as_str() != Some(property.kind)
                        || p["isArray"].as_bool().unwrap_or(false) != property.array
                        || p["isDictionary"].as_bool().unwrap_or(false)
                        || p["isSet"].as_bool().unwrap_or(false)
                        || (!property.nullable && p["isOptional"].as_bool().unwrap_or(false))
                        || property
                            .target
                            .is_some_and(|target| p["objectType"].as_str() != Some(target)) =>
                {
                    Some(format!(
                        "incompatible type/nullability; expected {}{}{}, found {}",
                        property.kind,
                        if property.array { "[]" } else { "" },
                        if property.nullable {
                            " (nullable allowed)"
                        } else {
                            " (non-null)"
                        },
                        p
                    ))
                }
                _ => None,
            };
            if let Some(problem) = problem {
                let qualified = format!("{class}.{}", property.name);
                result.missing.push(qualified.clone());
                if property.required {
                    result.errors.push(format!("{qualified}: {problem}"));
                } else {
                    result
                        .invalid_optional
                        .entry(class)
                        .or_default()
                        .push(property.name);
                }
            }
        }
    }
    result
}
impl Compatibility {
    /// Incompatible optional properties are treated exactly like absent ones.
    /// Embedded objects are projected recursively; ordinary links remain keys.
    fn project_row(&self, class: &str, row: &mut Value) {
        if let Some(object) = row.as_object_mut() {
            if let Some(invalid) = self.invalid_optional.get(class) {
                for property in invalid {
                    object.remove(*property);
                }
            }
            if let Some((_, properties)) = MODELS.iter().find(|(name, _)| *name == class) {
                for property in *properties {
                    if let Some(target) = property.target
                        && let Some(value) = object.get_mut(property.name)
                    {
                        if let Some(values) = value.as_array_mut() {
                            for nested in values {
                                self.project_row(target, nested);
                            }
                        } else if value.is_object() {
                            self.project_row(target, value);
                        }
                    }
                }
            }
        }
    }
    pub fn project(&self, tables: &mut HashMap<String, Vec<Value>>) {
        for (class, rows) in tables {
            for row in rows {
                self.project_row(class, row);
            }
        }
    }
}
