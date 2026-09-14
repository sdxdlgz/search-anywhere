"""T1-T3: real client traffic, usage cells, period switch, revoke and narrow viewport."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:8876"
ARTIFACTS = Path(__file__).resolve().parents[1] / "test-results"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1100}, reduced_motion="reduce")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.get_by_label("管理员口令").fill("admin-test-credential-only-123456")
    page.get_by_role("button", name="进入控制台").click()
    expect(page.get_by_role("heading", name="搜索概览.")).to_be_visible()
    for provider in ["exa", "tavily", "parallel"]:
        assert page.request.post(f"{BASE}/api/keys", data={"provider": provider, "label": "Usage fixture", "account": "test only", "keys": [f"{provider}-usage-browser-fixture-123456"]}).status == 201
    profile = page.request.get(f"{BASE}/api/profiles").json()[0]
    profile.update(modes={"exa": "auto", "parallel": None, "tavily": "basic", "anysearch": None, "keenable": None}, cache_ttl_seconds=120)
    assert page.request.put(f"{BASE}/api/profiles/{profile['id']}", data=profile).status == 200
    a = page.request.post(f"{BASE}/api/tokens", data={"name": "Codex fixture"}).json()
    b = page.request.post(f"{BASE}/api/tokens", data={"name": "Hermes fixture"}).json()

    def request(token, operation, body):
        response = page.request.post(f"{BASE}/v1/{operation}", headers={"Authorization": f"Bearer {token['token']}"}, data={**body, "profile": profile["id"]})
        assert response.status == 200
        return response.json()

    request(a, "search", {"query": "usage browser fixture"})
    assert request(a, "search", {"query": "usage browser fixture"})["cache_hit"]
    request(a, "fetch", {"url": "https://example.com/article"})
    profile.update(modes={"exa": None, "parallel": "basic", "tavily": None, "anysearch": None, "keenable": None}, parallel_transport="api")
    assert page.request.put(f"{BASE}/api/profiles/{profile['id']}", data=profile).status == 200
    request(b, "search", {"query": "unknown cost"})
    profile["parallel_transport"] = "free_first"
    assert page.request.put(f"{BASE}/api/profiles/{profile['id']}", data=profile).status == 200
    request(b, "search", {"query": "free search"})
    page.reload()
    page.get_by_role("button", name="客户端接入", exact=True).click()
    left = page.get_by_role("row").filter(has_text="Codex fixture")
    right = page.get_by_role("row").filter(has_text="Hermes fixture")
    expect(left).to_contain_text("3 次请求")
    expect(left).to_contain_text("上游调用 3 次 · 缓存 1 次")
    expect(left).to_contain_text("$0.014")
    expect(left).to_contain_text("Tavily 1 credits")
    expect(right).to_contain_text("2 次请求")
    expect(right).to_contain_text("免费调用 1 次")
    expect(right).to_contain_text("费用未知 1 次")
    expect(right).not_to_contain_text("$0")
    page.get_by_role("button", name="本月（UTC）", exact=True).click()
    expect(page.get_by_role("button", name="本月（UTC）", exact=True)).to_have_attribute("aria-pressed", "true")
    expect(left).to_contain_text("3 次请求")
    page.get_by_role("button", name="累计", exact=True).click()
    page.get_by_placeholder("客户端名称，例如 Hermes / Codex").fill("Unused fixture")
    page.get_by_role("button", name="生成访问凭证").click()
    page.get_by_role("button", name="我已保存").click()
    expect(page.get_by_role("row").filter(has_text="Unused fixture")).to_contain_text("尚无上游调用")
    right.get_by_role("button", name="撤销").click()
    expect(right.get_by_role("button", name="撤销")).to_be_disabled()
    expect(right).to_contain_text("2 次请求")
    for token in [a, b]:
        assert token["token"] not in page.locator("body").inner_text()
    page.screenshot(path=str(ARTIFACTS / "token-usage-desktop.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("group", name="凭证统计周期").scroll_into_view_if_needed()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(ARTIFACTS / "token-usage-mobile.png"), full_page=True)
    assert not errors, errors
    browser.close()
print("Client usage: HTTP traffic, costs/credits, free/unknown, period switch, revoke, secret masking and desktop/mobile passed")
