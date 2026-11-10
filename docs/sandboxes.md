# Selectable agent sandboxes

Agents configured to run on the host computer can select an execution boundary per agent.

## Providers

- `none`: explicit unsandboxed execution. This preserves the existing behavior.
- `ai-jail`: wraps each one-shot agent CLI launch with the locally installed `ai-jail` executable.

A selected provider is fail-closed. If `ai-jail` is not installed or cannot be located in `PATH`, the run returns an actionable error and is never retried without a sandbox.

## Policy

The provider contract accepts:

- `network`: whether the sandbox may use the network. This is needed by hosted model CLIs.
- `readOnlyPaths`: host paths mounted read-only.
- `readWritePaths`: host paths mounted read-write.
- `environment`: environment variable names explicitly passed through.

The current UI exposes provider selection. The policy fields are part of the generic persisted contract and will be exposed through the host-resource configuration UI as providers mature.

## Process behavior

Sandboxed agents use one-shot launches. Persistent CLI sessions are deliberately disabled for them until session-aware process wrappers are available. This prevents an existing long-lived CLI process from escaping the selected boundary.

Linux agents continue to use Tucano's existing isolated Docker computer. The selectable host sandbox applies to agents using `This computer` (macOS or another host execution mode).

## Security limitations

`ai-jail` is a policy boundary, not a VM. Sharing host paths, environment variables, network, or applications reduces isolation and must be explicit. A VM remains the stronger option when compromise resistance is more important than host integration.
