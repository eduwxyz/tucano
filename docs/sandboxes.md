# Selectable agent sandboxes

Agents configured to run on the host computer can select an execution boundary per agent.

## Providers

- `none`: explicit unsandboxed execution. This preserves the existing behavior.
- `ai-jail`: wraps each one-shot agent CLI launch with the locally installed `ai-jail` executable.

A selected provider is fail-closed. If `ai-jail` is not installed or cannot be located in `PATH`, the run returns an actionable error and is never retried without a sandbox.

## Policy

The provider contract accepts:

- `configFile`: an optional `.ai-jail` file selected by the user. It must be named `.ai-jail`; its containing directory becomes the project configuration directory while the agent workdir remains the child process's working directory.
- `network` and `allowHosts`: unrestricted or filtered egress.
- `readOnlyPaths`, `readWritePaths`, and `overlayPaths`: host mounts.
- `hideDotDirs`, `maskPaths`, `maskExceptPaths`, `denyPaths`, and `denyExceptPaths`: path hardening rules.
- `environment` and `envFromFiles`: explicitly passed environment values or files. Environment files are chosen with the native file picker.
- `privateHome`, `lockdown`, `landlock`, `seccomp`, `rlimits`, `agentState`, `inheritEnv`, `systemdUser`, `gpu`, `display`, `audio`, `kvm`, `macosHostIpc`, `x11`, and `hostShm`: isolation, device, and process policy.
- `github`, `aws`, `kube`, `gcloud`, `dockerConfig`, `ssh`, `pictures`, `docker`, `tailscale`, `terminalPassthrough`, `worktree`, `mise`, and `toolchains`: explicit host integrations.
- `updateCheck`, `saveConfig`, `hideConfig`, `exec`, and `claudeDir`: launch and configuration behavior.
- `browser`, `auditLog`, and `statusBar`: browser and observability settings.
- Filtered egress uses `allowHosts`; Tucano never emits `--network` together with `--allow-host`.

The agent settings UI exposes these settings only inside the `This computer` section. Path fields include a native Finder/file-picker action; the selected paths remain visible as editable text so they can also be pasted or adjusted. The agent work directory is always mounted read-write for the selected local run.

## Process behavior

Sandboxed agents use one-shot launches. Persistent CLI sessions are deliberately disabled for them until session-aware process wrappers are available. This prevents an existing long-lived CLI process from escaping the selected boundary.

Linux agents continue to use Tucano's existing isolated Docker computer. The selectable host sandbox applies to agents using `This computer` (macOS or another host execution mode).

## Security limitations

`ai-jail` is a policy boundary, not a VM. Sharing host paths, environment variables, network, or applications reduces isolation and must be explicit. A VM remains the stronger option when compromise resistance is more important than host integration.
