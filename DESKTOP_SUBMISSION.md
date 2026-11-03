# Immediate desktop submission prototype

Run `node queue.mjs serve --desktop --port 4322` to opt in. The authenticated local UI calls the Windows helper directly when the owner sends a reviewed direction. There is no scheduled model relay or app-server writer lease. This prototype is not enabled by default and has not passed a real submission round trip on the installed Codex build.

The helper discovers the installed OpenAI.Codex package window, requests its standard MSAA accessibility object, navigates the existing task deeplink, then independently checks Codex's Copy deeplink result. Clipboard contents are restored if unchanged by another actor. Prompt insertion uses ValuePattern, not clipboard paste or global keystrokes. A nonempty composer stops the operation. The task identity and exact composer text are checked again before invoking Send message. Confirmation requires an empty composer and the exact prompt appearing in the accessibility tree of the same task.

The queue records an attempt before submission and never retries it automatically. A visible submission receipt is not proof of completed work and does not invent a native turn ID. Source receipt reconciliation remains separate. Uncertain attempts must be inspected before another send. Multiple local helper invocations are serialized by an exclusive filesystem lock.

Current limitations: English control labels, one installed Codex window, transient menus, and UI changes. Concurrent human navigation or editing can interrupt the operation. The initial live probe exposed the composer after requesting MSAA and stopped on an existing draft without replacing it. The Send control and complete live round trip still require a clean disposable task test. Claude is unsupported. The prototype does not automatically advance the pet queue or refresh model results from desktop controls.

References: [Microsoft ValuePattern](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue), [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility). Task deeplink format was checked against the locally installed Codex app code. No app files are patched.
