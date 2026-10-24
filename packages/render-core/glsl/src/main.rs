//! Reads render-core's WGSL on stdin and writes, as JSON on stdout, the GLSL
//! ES 3.00 (WebGL2) vertex and fragment shaders naga translates it to, with
//! the GLSL names of its uniform blocks and textures.
use naga::back::glsl;
use std::fmt::Write as _;
use std::io::Read as _;
use std::process::ExitCode;

fn json(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn run() -> Result<String, String> {
    let mut source = String::new();
    std::io::stdin()
        .read_to_string(&mut source)
        .map_err(|e| e.to_string())?;
    let module =
        naga::front::wgsl::parse_str(&source).map_err(|e| e.emit_to_string(&source))?;
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .map_err(|e| format!("{e:?}"))?;
    let name = |handle: naga::Handle<naga::GlobalVariable>| module.global_variables[handle].name.clone().unwrap_or_default();
    let mut stages = Vec::new();
    for (stage, entry) in [
        (naga::ShaderStage::Vertex, "vs"),
        (naga::ShaderStage::Fragment, "fs"),
    ] {
        // WebGPU's clip space is kept: render-core flips rows itself where
        // WebGL2's bottom-up framebuffers differ (readback), and draws at z = 0.
        let options = glsl::Options {
            version: glsl::Version::Embedded {
                version: 300,
                is_webgl: true,
            },
            writer_flags: glsl::WriterFlags::empty(),
            ..Default::default()
        };
        let pipeline = glsl::PipelineOptions {
            shader_stage: stage,
            entry_point: entry.into(),
            multiview: None,
        };
        let mut code = String::new();
        let reflection = glsl::Writer::new(
            &mut code,
            &module,
            &info,
            &options,
            &pipeline,
            naga::proc::BoundsCheckPolicies::default(),
        )
        .and_then(|mut writer| writer.write())
        .map_err(|e| format!("{entry}: {e:?}"))?;
        let mut uniforms: Vec<_> = reflection
            .uniforms
            .iter()
            .map(|(handle, block)| format!("{}:{}", json(&name(*handle)), json(block)))
            .collect();
        uniforms.sort();
        let mut textures: Vec<_> = reflection
            .texture_mapping
            .iter()
            .map(|(glsl, mapping)| format!("{}:{}", json(&name(mapping.texture)), json(glsl)))
            .collect();
        textures.sort();
        stages.push(format!(
            "{}:{{\"code\":{},\"uniforms\":{{{}}},\"textures\":{{{}}}}}",
            json(entry),
            json(&code),
            uniforms.join(","),
            textures.join(",")
        ));
    }
    Ok(format!("{{{}}}\n", stages.join(",")))
}

fn main() -> ExitCode {
    match run() {
        Ok(out) => {
            print!("{out}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
