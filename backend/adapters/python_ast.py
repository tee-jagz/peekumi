"""Read source from JSON stdin; never import or execute inspected code."""
import ast
import hashlib
import json
import sys


def annotation(node):
    """Print an explicit annotation or default expression without evaluating it; return None when absent."""
    return ast.unparse(node) if node is not None else None


def details(node):
    """Extract authored docstrings, signatures, argument kinds, defaults and explicit types from an AST declaration."""
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


def body_hash(node):
    """Hash a declaration's statements without its leading docstring, so documentation and signature edits stay separate."""
    body = list(node.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], 'value', None), ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    if isinstance(node, ast.ClassDef):
        body = [item for item in body if not isinstance(item, ast.AnnAssign)]
    return hashlib.sha256(''.join(ast.dump(item, include_attributes=False) for item in body).encode()).hexdigest()


def relationships(tree, symbols):
    """Extract declaration-level relationships; dynamic receivers and shadowed names stay unresolved."""
    result, bindings = [], {}
    names = {s['name'] for s in symbols}
    global_writes = set()
    class Writes(ast.NodeVisitor):
        def visit_Name(self,node):
            if isinstance(node.ctx,(ast.Store,ast.Del)): global_writes.add(node.id)
        def visit_FunctionDef(self,node): pass
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_ClassDef(self,node): pass
    Writes().visit(tree)
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != '*':
                    bindings[alias.asname or alias.name] = {'specifier': node.module or '', 'level': node.level, 'names': [alias.name], 'name': alias.name}
        elif isinstance(node, ast.Import):
            for alias in node.names:
                bindings[alias.asname or alias.name] = {'specifier': alias.name, 'level': 0, 'names': [], 'namespace': True}
    def bind(found, node):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != '*':
                    found.setdefault(alias.asname or alias.name, []).append({'specifier': node.module or '', 'level': node.level, 'names': [alias.name], 'name': alias.name})
        elif isinstance(node, ast.Import):
            for alias in node.names:
                found.setdefault(alias.asname or alias.name, []).append({'specifier': alias.name, 'level': 0, 'names': [], 'namespace': True})
    def record(owner, target, kind, node, blocked=(), klass=None, receiver=None, local=None):
        entry = {'source': owner, 'target': target, 'kind': kind, 'line': node.lineno}
        root = target.split('.')[0]
        parts = target.split('.')
        # An import inside the function binds its name for that function only.
        scope = {**bindings, **local} if local and root in local else bindings
        if klass and receiver and len(parts) == 2 and parts[0] == receiver and parts[1].isidentifier():
            # self.method() or cls.method() in a class: a method of that class (or unresolved).
            entry['lookup'] = {'method': {'type': klass, 'fields': [], 'name': parts[1]}}
        elif root in blocked or (root in global_writes and scope is bindings):
            entry['reason'] = 'Name is shadowed or assigned in this scope'
        elif root in bindings and root in names and scope is bindings:
            entry['reason'] = 'Conflicting local and imported declarations'
        elif target in scope and not scope[target].get('namespace'):
            entry['lookup'] = {'import': scope[target], 'name': scope[target]['name']}
        elif target in names and '.' not in target:
            entry['lookup'] = {'local': target}
        else:
            match = next((alias for alias in scope if scope[alias].get('namespace') and target.startswith(alias + '.')), None)
            if match:
                entry['lookup'] = {'import': scope[match], 'name': target[len(match)+1:]}
            else:
                entry['reason'] = 'Dynamic receiver, external name or unsupported lexical binding'
        result.append(entry)
    class Calls(ast.NodeVisitor):
        def __init__(self, owner, blocked, klass=None, receiver=None, local=None):
            self.owner, self.blocked, self.klass, self.receiver, self.local = owner, blocked, klass, receiver, local
        def visit_Call(self, node):
            record(self.owner, ast.unparse(node.func), 'calls', node, self.blocked, self.klass, self.receiver, self.local)
            self.generic_visit(node)
        def visit_FunctionDef(self, node): pass
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_ClassDef(self, node): pass
        def visit_Lambda(self, node): pass
    def functions(body, prefix=''):
        for node in body:
            if isinstance(node, ast.ClassDef):
                for base in node.bases: record(prefix+node.name, ast.unparse(base), 'inherits', base)
                functions(node.body, prefix+node.name+'.')
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                blocked = {a.arg for a in node.args.posonlyargs+node.args.args+node.args.kwonlyargs}
                blocked.update(a.arg for a in [node.args.vararg,node.args.kwarg] if a)
                imported = {}
                for child in ast.walk(node):
                    if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store,ast.Del)): blocked.add(child.id)
                    if isinstance(child, (ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) and child is not node: blocked.add(child.name)
                    if isinstance(child,(ast.Import,ast.ImportFrom)): bind(imported, child)
                # A name that one import in the body binds, and nothing else, resolves through that
                # import. A dotted `import a.b` or a name bound twice stays shadowed.
                local = {}
                for name, found in imported.items():
                    if name in blocked or len(found) > 1 or '.' in name: blocked.add(name.split('.')[0])
                    else: local[name] = found[0]
                # In a class, the first parameter (self or cls) names the class itself, unless the
                # method is a staticmethod or the name is bound again in the body.
                params = node.args.posonlyargs + node.args.args
                static = any(ast.unparse(d) == 'staticmethod' for d in node.decorator_list)
                receiver = params[0].arg if prefix and params and not static else None
                if receiver and any(isinstance(c, ast.Name) and c.id == receiver and isinstance(c.ctx, (ast.Store, ast.Del)) for c in ast.walk(node)):
                    receiver = None
                visitor=Calls(prefix+node.name,blocked,prefix[:-1] if prefix else None,receiver,local)
                for statement in node.body: visitor.visit(statement)
    functions(tree.body)
    return result


def analyze(source):
    """Parse one Python source string into symbols, imports and module metadata. Syntax failures return an explicit parse-error result; inspected code is never imported."""
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
                                'hash': hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest(),
                                'body': body_hash(node)})
                if isinstance(node, ast.ClassDef):
                    walk(node.body, name + '.')
    walk(tree.body)
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend({'specifier': item.name, 'level': 0, 'names': []} for item in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.append({'specifier': node.module or '', 'level': node.level, 'names': [item.name for item in node.names]})
    return {'symbols': symbols, 'imports': imports, 'details': details(tree), 'relationships': relationships(tree, symbols), 'analysis': 'Python AST'}


json.dump([analyze(source) for source in json.load(sys.stdin)], sys.stdout)
