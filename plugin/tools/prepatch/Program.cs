// Make BepInEx's HarmonyInteropFix.Apply a no-op, since its runtime detour
// crashes on Apple Silicon and nothing we load needs it
using Mono.Cecil;
using Mono.Cecil.Cil;

var src = args[0]; var dst = args[1];
var resolver = new DefaultAssemblyResolver();
foreach (var d in args.Skip(2)) resolver.AddSearchDirectory(d);
resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(src)));
var asm = AssemblyDefinition.ReadAssembly(src, new ReaderParameters { InMemory = true, AssemblyResolver = resolver });
var type = asm.MainModule.GetType("BepInEx.Preloader.RuntimeFixes.HarmonyInteropFix") ?? throw new Exception("type not found");
var apply = type.Methods.Single(m => m.Name == "Apply");
var body = apply.Body;
body.Instructions.Clear(); body.ExceptionHandlers.Clear(); body.Variables.Clear();
body.GetILProcessor().Append(Instruction.Create(OpCodes.Ret));
asm.Write(dst);
Console.WriteLine("patched " + apply.FullName);
