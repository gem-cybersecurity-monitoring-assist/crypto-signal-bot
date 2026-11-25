from scripts.repo_audit import build_backend_import_graph, detect_cycles


def test_backend_import_graph_has_no_cycles():
    graph = build_backend_import_graph()
    assert detect_cycles(graph) == []


def test_exact_typescript_alias_resolves_and_missing_target_fails(tmp_path, monkeypatch):
    from scripts import repo_audit

    src = tmp_path / "src"
    src.mkdir()
    (src / "lib").mkdir()
    (src / "app.ts").write_text("import { api } from '@/lib/backend';")
    (tmp_path / "tsconfig.json").write_text(
        '{"compilerOptions":{"baseUrl":".","paths":'
        '{"@/lib/backend":["src/lib/backendRuntime.ts"],"@/*":["src/*"]}}}'
    )
    monkeypatch.setattr(repo_audit, "ROOT", tmp_path)
    monkeypatch.setattr(repo_audit, "FRONTEND_ROOT_CANDIDATES", [src])
    runtime = src / "lib" / "backendRuntime.ts"
    runtime.write_text("export const api = {};")
    assert repo_audit.check_frontend_relative_imports() == []
    runtime.unlink()
    # A legacy file must not conceal a missing exact alias target.
    (src / "lib" / "backend.ts").write_text("export const api = {};")
    assert repo_audit.check_frontend_relative_imports() == [
        "src/app.ts -> @/lib/backend"
    ]
