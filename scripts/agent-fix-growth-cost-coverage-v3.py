from pathlib import Path
import traceback

source_path = Path("scripts/agent-fix-growth-cost-coverage.py")
source = source_path.read_text(encoding="utf-8")

old_helper = '''def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)
'''

new_helper = '''def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if label == "growth monthly product return first" and count == 2:
        return text.replace(old, new, 1)
    if label in {"growth reliable monthly KPI", "growth reliable machine KPI"} and count == 0:
        variable = "averageMonthlyOperatingProfit" if label == "growth reliable monthly KPI" else "averageMachineProfitAfterRent"
        replacement = "reliableAverageMonthlyOperatingProfit" if label == "growth reliable monthly KPI" else "reliableAverageMachineProfitAfterRent"
        updated, replacements = re.subn(rf"(?m)^(\\s*){re.escape(variable)},\\s*$", rf"\\1{replacement},", text, count=1)
        if replacements == 1:
            return updated
    if label == "investor source note" and count == 0:
        pattern = r'(?m)^(\\s*)`VMS rows: \\${salesResult\\.data\\?\\.length \\?\\? 0}`,\\s*$'
        def insert_source(match):
            indent = match.group(1)
            return f'{indent}`VMS source: ${{salesResult.source ?? "unavailable"}}`,\\n{indent}`VMS rows: ${{salesResult.data?.length ?? 0}}`,'
        updated, replacements = re.subn(pattern, insert_source, text, count=1)
        if replacements == 1:
            return updated
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)
'''

try:
    if source.count(old_helper) != 1:
        raise RuntimeError("Could not locate original replace_once helper.")
    patched_source = source.replace(old_helper, new_helper, 1)
    namespace = {"__name__": "__main__", "__file__": str(source_path)}
    exec(compile(patched_source, str(source_path), "exec"), namespace)

    test_path = Path("scripts/test-growth-investor-portal.mjs")
    test_source = test_path.read_text(encoding="utf-8")
    old_assertion = '''  assert.match(
    growth,
    /manualCoverageComplete && vmsCoverageComplete[\\s\\S]*completeMonthly\\.length/,
  );'''
    new_assertions = '''  assert.match(
    growth,
    /historyMonthCount: manualCoverageComplete \\? completeMonthly\\.length : 0/,
  );
  assert.match(growth, /costCoverageComplete: vmsCoverageComplete/);
  assert.match(
    growth,
    /reliableProfitCoverage = vmsCoverageComplete && manualCoverageComplete/,
  );'''
    if test_source.count(old_assertion) != 1:
        raise RuntimeError("Could not locate stale growth coverage assertion.")
    test_path.write_text(test_source.replace(old_assertion, new_assertions, 1), encoding="utf-8")
except Exception:
    diagnostic = traceback.format_exc()
    Path("scripts/agent-growth-patch-error.txt").write_text(diagnostic, encoding="utf-8")
    print(diagnostic)
    raise
