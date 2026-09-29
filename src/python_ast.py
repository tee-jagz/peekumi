"""Read source from JSON stdin; never import or execute inspected code."""
import ast
import hashlib
import json
import sys


def annotation(node):
    return ast.unparse(node) if node is not None else None


def details(node):
    result = {'description': ast.get_docstring(node) or '', 'provenance': 'Python docstring / annotations'}
    if isinstance(node, ast.ClassDef):
        result['bases'] = [annotation(base) for base in node.bases]
        result['signature'] = 'class ' + node.name + ('(' + ', '.join(result['bases']) + ')' if result['bases'] else '')
        result['fields'] = [{'name': annotation(item.target), 'type': annotation(item.annotation)}
                            for item in node.body if isinstance(item, ast.AnnAssign)]
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = node.args
        positional = args.posonlyargs + args.args
        defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
        params = []
        for index, (arg, default) in enumerate(zip(positional, defaults)):
            params.append({'name': arg.arg, 'type': annotation(arg.annotation), 'default': annotation(default),
                           'kind': 'positional-only' if index < len(args.posonlyargs) else 'positional or keyword'})
        if args.vararg:
            params.append({'name': '*' + args.vararg.arg, 'type': annotation(args.vararg.annotation), 'kind': 'variadic positional'})
        for arg, default in zip(args.kwonlyargs, args.kw_defaults):
            params.append({'name': arg.arg, 'type': annotation(arg.annotation), 'default': annotation(default), 'kind': 'keyword-only'})
        if args.kwarg:
            params.append({'name': '**' + args.kwarg.arg, 'type': annotation(args.kwarg.annotation), 'kind': 'variadic keyword'})
        result.update({'parameters': params, 'returns': annotation(node.returns),
                       'async': isinstance(node, ast.AsyncFunctionDef),
                       'signature': ('async ' if isinstance(node, ast.AsyncFunctionDef) else '') + 'def ' + node.name + '(' + annotation(args) + ')' + (' -> ' + annotation(node.returns) if node.returns else '')})
    return result


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
                symbols.append({'name': name, 'kind': 'class' if isinstance(node, ast.ClassDef) else ('method' if prefix else 'function'),
                                'start': start, 'end': node.end_lineno, 'details': details(node),
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
    return {'symbols': symbols, 'imports': imports, 'details': details(tree), 'analysis': 'Python AST'}


json.dump([analyze(source) for source in json.load(sys.stdin)], sys.stdout)
