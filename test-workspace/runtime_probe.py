import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
result = {"python": sys.executable, "prefix": sys.prefix, "condaPrefix": os.environ.get("CONDA_PREFIX")}
if len(sys.argv) < 3 or sys.argv[2] != "stdlib":
    import torch

    result["torch"] = torch.__version__
output = sys.argv[1] if len(sys.argv) > 1 else "custom-runtime-results.json"
Path(__file__).with_name(output).write_text(json.dumps(result), encoding="utf-8")
print(json.dumps(result))
