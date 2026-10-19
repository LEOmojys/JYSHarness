' Launch JYSHarness without a flashing console window.
' WshShell.Run cannot execute .cmd directly (CreateProcess, no shell) - it must
' go through cmd.exe, otherwise the launch silently does nothing.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
q = Chr(34)
cmd = "cmd.exe /c " & q & root & "\jysharness.cmd" & q & " desktop"
sh.Run cmd, 0, False
