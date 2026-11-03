param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetNative {
 [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
'@
$request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
$scope = [System.Windows.Automation.TreeScope]::Descendants
$script:submitted = $false
$script:wrote = $false
function Root {
 $windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$' })
 if ($windows.Count -ne 1) { throw 'Exactly one installed Codex window is required.' }
 $script:app = $windows[0]
 $guid = [Guid]'618736e0-3c3d-11cf-810c-00aa00389b71'; $accessible = $null
 $null = [PetNative]::AccessibleObjectFromWindow($script:app.MainWindowHandle,4294967292,[ref]$guid,[ref]$accessible)
 return [System.Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
}
function Named($root, $name, $type) {
 $condition = [System.Windows.Automation.AndCondition]::new(
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name),
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$type))
 $deadline=[DateTime]::UtcNow.AddSeconds(2)
 do { $items = $root.FindAll($scope,$condition); if($items.Count -ne 0) { break }; Start-Sleep -Milliseconds 80 } while([DateTime]::UtcNow -lt $deadline)
 if ($items.Count -ne 1) { throw "Expected one $name control; found $($items.Count)." }
 return $items[0]
}
function Expand($element) { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); Start-Sleep -Milliseconds 180 }
function Invoke($element) { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function TaskLink($root) {
 # Clipboard is used only for the app's own identity command, never for the prompt.
 $original = [System.Windows.Forms.Clipboard]::GetDataObject()
 $saved = [System.Windows.Forms.DataObject]::new()
 if ($original) { foreach($format in $original.GetFormats($false)) { $saved.SetData($format,$false,$original.GetData($format,$false)) } }
 $copied = $null
 try {
  Expand (Named $root 'Chat actions' ([System.Windows.Automation.ControlType]::Button))
  Expand (Named $root 'Copy' ([System.Windows.Automation.ControlType]::MenuItem))
  $before = [PetNative]::GetClipboardSequenceNumber()
  Invoke (Named $root 'Copy deeplink Alt+Ctrl+L' ([System.Windows.Automation.ControlType]::MenuItem))
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while([PetNative]::GetClipboardSequenceNumber() -eq $before -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 40 }
  if ([PetNative]::GetClipboardSequenceNumber() -eq $before) { throw 'Task identity command did not return a link.' }
  $copied = [System.Windows.Forms.Clipboard]::GetText()
  if ($copied -notmatch '^codex://threads/[0-9a-f-]+$') { throw 'The current window is not a verified Codex task.' }
  return $copied
 } finally {
  if ($null -ne $copied -and [System.Windows.Forms.Clipboard]::GetText() -ceq $copied) {
   if($original) { [System.Windows.Forms.Clipboard]::SetDataObject($saved,$true) } else { [System.Windows.Forms.Clipboard]::Clear() }
  }
 }
}
function Composer($root) { return Named $root 'Do anything' ([System.Windows.Automation.ControlType]::Edit) }
function RequireIdle($root) {
 $buttons=$root.FindAll($scope,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
 foreach($button in $buttons) { if($button.Current.Name -match '^(Stop|Stop generating|Stop task|Interrupt|Steer prompt|Queue prompt)$') { throw 'This task appears busy. No prompt will be inserted.' } }
}
function Value($element) { return $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) }
function VerifyTask($root) {
 if ((TaskLink $root) -cne "codex://threads/$($request.threadId)") { throw 'Destination changed. Nothing will be sent to another task.' }
}
try {
 if ($request.threadId -notmatch '^[0-9a-f]{8}-[0-9a-f-]{27}$') { throw 'Invalid task ID.' }
 $root = Root
 if ($request.mode -eq 'probe') {
  # Navigation is read-only; it cannot create a task or claim its writer lease.
  Start-Process -FilePath $script:app.Path -ArgumentList "codex://threads/$($request.threadId)" -WindowStyle Hidden
  Start-Sleep -Milliseconds 650
  $root = Root
  VerifyTask $root
  RequireIdle $root
  $editor = Composer $root; $value = Value $editor
  if ($value.Current.IsReadOnly -or !$editor.Current.IsEnabled) { throw 'The composer is not writable.' }
  if ($value.Current.Value.Length -ne 0) { throw 'This task has an existing draft. It was left untouched.' }
  @{ok=$true;threadId=$request.threadId;emptyDraft=$true;observedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  exit 0
 }
 if ($request.mode -ne 'submit' -or !$request.prompt -or $request.prompt.Length -gt 20000) { throw 'Invalid submission.' }
 VerifyTask $root
 RequireIdle $root
 $editor = Composer $root; $value = Value $editor
 if ($value.Current.IsReadOnly -or !$editor.Current.IsEnabled -or $value.Current.Value.Length -ne 0) { throw 'Composer unavailable or contains a draft. It was left untouched.' }
 $messageCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,[string]$request.prompt)
 $existingMatches=$root.FindAll($scope,$messageCondition).Count
 $value.SetValue($request.prompt); $script:wrote=$true
 Start-Sleep -Milliseconds 200
 VerifyTask (Root)
 $editor = Composer (Root)
 if ((Value $editor).Current.Value -cne $request.prompt) { throw 'Composer text changed. Submission stopped.' }
 $send = Named (Root) 'Send message' ([System.Windows.Automation.ControlType]::Button)
 if (!$send.Current.IsEnabled) { throw 'Send is not enabled. The prompt remains an unsent draft.' }
 # No global keystrokes or clipboard paste. Invoke the verified composer control.
 $script:submitted=$true
 Invoke $send
 $deadline=[DateTime]::UtcNow.AddSeconds(6); $confirmed=$false
 while([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 150
  $root=Root
  $empty=(Value (Composer $root)).Current.Value.Length -eq 0
  $matches=$root.FindAll($scope,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,[string]$request.prompt))
  if($empty -and $matches.Count -gt $existingMatches) { VerifyTask $root; $confirmed=$true; break }
 }
 if(!$confirmed) { throw 'Submission was invoked, but its message receipt is not visible. Do not resend.' }
 @{ok=$true;threadId=$request.threadId;submitted=$true;confirmed=$true;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
} catch {
 @{ok=$false;error=$_.Exception.Message;submitted=$script:submitted;draftWritten=$script:wrote} | ConvertTo-Json -Compress
 exit 1
}
