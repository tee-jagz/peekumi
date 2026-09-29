"""Read source from JSON stdin; never import or execute inspected code."""
import ast
import hashlib
import json
import sys


def analyze(source):
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError) as error:
        return {'symbols': [], 'imports': [], 'analysis': 'parse error: ' + str(error)}
    symbols = []

    def walk(body, prefix=''):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = prefix + node.name
                start = min([node.lineno] + [d.lineno for d in node.decorator_list])
                symbols.append({'name': name, 'kind': 'class' if isinstance(node, ast.ClassDef) else 'function',
                                'start': start, 'end': node.end_lineno,
                                'hash': hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest()})
                if isinstance(node, ast.ClassDef):
                    walk(node.body, name + '.')
    walk(tree.body)
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend({'specifier': item.name, 'level': 0, 'names': []} for item in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.append({'specifier': node.module or '', 'level': node.level, 'names': [item.name for item in node.names]})
    return {'symbols': symbols, 'imports': imports, 'analysis': 'Python AST'}


json.dump([analyze(source) for source in json.load(sys.stdin)], sys.stdout)
