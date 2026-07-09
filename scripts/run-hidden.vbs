Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = projectDir
' 0 = hidden window, False = do not wait for the process to exit
sh.Run "node server.js", 0, False
