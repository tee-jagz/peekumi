"""Compute cyclomatic complexity of Python functions using the standard AST only.

Reads JSON `{"files": [{"path": "...", "source": "..."}]}` on stdin and writes JSON
`{"functions": [{"path": "...", "name": "...", "start": 1, "end": 5, "complexity": 2}]}`
on stdout. Never executes inspected repository code.
"""

import ast
import json
import sys


def complexity(node):
    """McCabe cyclomatic complexity for a Python function or method body."""
    score = 1
    stack = list(node.body)
    while stack:
        cur = stack.pop()
        # Do not double-count nested function or class definitions.
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(
            cur,
            (
                ast.If,
                ast.For,
                ast.AsyncFor,
                ast.While,
                ast.ExceptHandler,
                ast.IfExp,
                ast.Assert,
            ),
        ):
            score += 1
        elif isinstance(cur, ast.BoolOp):
            score += max(0, len(cur.values) - 1)
        elif isinstance(cur, ast.comprehension):
            score += 1 + len(cur.ifs)
        elif hasattr(ast, "match_case") and isinstance(cur, ast.match_case):
            # Ignore default wildcard case `_`
            if not (isinstance(cur.pattern, ast.MatchAs) and cur.pattern.name is None):
                score += 1
        stack.extend(ast.iter_child_nodes(cur))
    return score


def collect(tree, path):
    """Collect qualified function/method names matching backend/adapters/python_ast.py."""
    found = []

    def walk(body, prefix):
        for node in body:
            if isinstance(node, ast.ClassDef):
                name = f"{prefix}.{node.name}" if prefix else node.name
                walk(node.body, name)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = f"{prefix}.{node.name}" if prefix else node.name
                start = getattr(node, "lineno", 0)
                end = getattr(node, "end_lineno", start) or start
                found.append(
                    {
                        "path": path,
                        "name": name,
                        "start": start,
                        "end": end,
                        "complexity": complexity(node),
                    }
                )
                walk(node.body, name)

    walk(tree.body, "")
    return found


def main():
    payload = json.loads(sys.stdin.read())
    functions = []
    errors = []
    for item in payload.get("files", []):
        path = item.get("path", "")
        source = item.get("source", "")
        try:
            tree = ast.parse(source, filename=path)
            functions.extend(collect(tree, path))
        except SyntaxError as exc:
            errors.append({"path": path, "error": str(exc)})
    print(json.dumps({"functions": functions, "errors": errors}))


if __name__ == "__main__":
    main()
