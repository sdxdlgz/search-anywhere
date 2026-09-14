"""Single/batch quota actions against the isolated fixture; no production credentials."""
from pathlib import Path
from playwright.sync_api import expect


def check_usage_refresh(page, expected_errors):
    base = "http://127.0.0.1:8876"
    created = page.request.post(f"{base}/api/keys", data={
        "provider": "tavily", "label": "Usage extra", "account": "usage-test@example.com",
        "keys": ["tvly-usage-second-test-12345678", "tvly-usage-third-test-12345678"],
    })
    assert created.status == 201
    extra = created.json()
    page.get_by_role("button", name="刷新数据", exact=True).click()
    expect(page.get_by_text(extra[0]["label"], exact=True)).to_be_visible()
    page.get_by_role("button", name="测试 Browser Tavily", exact=True).click()
    expect(page.get_by_role("status")).to_contain_text("密钥测试成功")
    target = next(k for k in page.request.get(f"{base}/api/keys").json() if k["label"] == "Browser Tavily")
    target_url = f"{base}/api/keys/{target['id']}/usage"
    second_url = f"{base}/api/keys/{extra[0]['id']}/usage"
    third_url = f"{base}/api/keys/{extra[1]['id']}/usage"
    requests, local_reads, pending = [], [], []

    def capture(request):
        if request.method == "POST" and request.url.endswith("/usage"):
            requests.append(request.url)
        if request.method == "GET" and "/api/" in request.url:
            local_reads.append(request.url)

    page.on("request", capture)
    page.route(target_url, lambda route: pending.append(route))
    page.get_by_role("button", name="查询 Browser Tavily 用量", exact=True).click()
    expect(page.get_by_role("button", name="查询 Browser Tavily 用量", exact=True)).to_be_disabled()
    expect(page.get_by_role("button", name=f"查询 {extra[0]['label']} 用量", exact=True)).to_be_enabled()
    expect(page.get_by_role("button", name="测试 Browser Exa", exact=True)).to_be_enabled()
    assert requests == [target_url]
    page.get_by_role("button", name=f"查询 {extra[0]['label']} 用量", exact=True).click()
    expect(page.get_by_role("button", name=f"查询 {extra[0]['label']} 用量", exact=True)).to_be_enabled()
    assert len(pending) == 1
    pending.pop().continue_()
    page.unroute(target_url)
    expect(page.get_by_role("button", name="查询 Browser Tavily 用量", exact=True)).to_be_enabled()
    row = page.get_by_role("row").filter(has=page.get_by_text("Browser Tavily", exact=True))
    expect(row).to_contain_text("本月已记录 1 credits")
    expect(row).to_contain_text("官方 key 已用 0 credits")
    expect(row).to_contain_text("账号套餐已用 0 / 1,000")
    expect(row).to_contain_text("查询于")
    assert not local_reads, "One-row quota refresh must not reload every local record"
    assert requests == [target_url, second_url]

    batch = page.get_by_role("button", name="批量查询所选用量", exact=False)
    expect(batch).to_be_disabled()
    page.get_by_role("checkbox", name="选择 Browser Tavily", exact=True).check()
    page.get_by_role("checkbox", name=f"选择 {extra[1]['label']}", exact=True).check()
    before = page.request.get(f"{base}/api/keys").json()
    second_snapshot = next(k["usage"] for k in before if k["id"] == extra[0]["id"])
    expected_errors.add(third_url)
    page.route(third_url, lambda route: route.fulfill(status=502, json={"error": {"message": "模拟官方用量查询失败"}}))
    requests.clear()
    batch.click()
    expect(page.locator(".batch-results")).to_contain_text("批量查询完成 · 2 / 2")
    expect(page.locator(".batch-results")).to_contain_text("成功 1 · 失败 1")
    expect(page.locator(".batch-results")).not_to_contain_text("官方快照已刷新")
    assert sorted(requests) == sorted([target_url, third_url]), "Batch must touch selected credentials only"
    after = page.request.get(f"{base}/api/keys").json()
    assert next(k["usage"] for k in after if k["id"] == extra[0]["id"]) == second_snapshot
    expect(page.get_by_role("button", name=f"查询 {extra[1]['label']} 用量", exact=True)).to_be_enabled()
    expect(page.locator(".batch-results")).not_to_be_visible(timeout=9500)
    failed_row = page.get_by_role("row").filter(has=page.get_by_text(extra[1]["label"], exact=True))
    expect(failed_row).to_contain_text("同步失败")
    page.unroute(third_url)
    page.get_by_role("button", name=f"查询 {extra[1]['label']} 用量", exact=True).click()
    expect(page.get_by_role("button", name=f"查询 {extra[1]['label']} 用量", exact=True)).to_be_enabled()
    assert requests.count(third_url) == 2
    batch.click()
    expect(page.locator(".batch-results")).to_contain_text("成功 2 · 失败 0")
    page.route(target_url, lambda route: pending.append(route))
    batch.click()
    expect(page.locator(".batch-results")).to_contain_text("批量查询中")
    page.wait_for_timeout(5500)
    expect(page.locator(".batch-results")).to_contain_text("批量查询中")
    assert len(pending) == 1
    pending.pop().continue_()
    page.unroute(target_url)
    expect(page.locator(".batch-results")).to_contain_text("批量查询完成")
    expect(page.locator(".batch-results")).not_to_be_visible(timeout=6500)
    expect(page.get_by_text("仅 Usage extra 2 的官方用量已刷新。", exact=True)).not_to_be_visible()
    page.get_by_role("button", name="暂停自动同步", exact=True).click()
    expect(page.get_by_text("自动同步：已关闭", exact=True)).to_be_visible()
    calls = len(requests)
    page.get_by_role("button", name="刷新数据", exact=True).click()
    expect(page.get_by_role("status").filter(has_text="页面数据已刷新")).to_be_visible()
    assert len(requests) == calls
    row.scroll_into_view_if_needed()
    page.screenshot(path=str(Path(__file__).resolve().parents[1] / "test-results" / "usage-refresh.png"), animations="disabled")
    page.remove_listener("request", capture)
