"""K1-K5 acceptance through the real UI with isolated fake upstream credentials."""
import re
from playwright.sync_api import expect


def check_keenable_login(page, artifacts):
    base = 'http://127.0.0.1:8876'
    keys = page.request.get(f'{base}/api/keys').json()
    key = next(k for k in keys if k['label'] == 'Browser Keenable')
    calls = page.request.get(f'{base}/api/dashboard').json()['calls']
    row = page.locator('tr').filter(has=page.get_by_text('Browser Keenable', exact=True))

    def open_login():
        page.get_by_role('button', name='配置 Browser Keenable 登录凭证', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('heading', name='Keenable 登录凭证')).to_be_visible()
        expect(dialog.get_by_label('Access token（可选）')).to_have_attribute('type', 'password')
        expect(dialog.get_by_label('Refresh token', exact=True)).to_have_attribute('type', 'password')
        expect(dialog.get_by_label('Refresh token', exact=True)).to_have_value('')
        return dialog

    dialog = open_login()
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-browser-refresh')
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    expect(row).to_contain_text('免费额度 100,000 credits')
    expect(row).to_contain_text('付费余额 25 credits')
    public = page.request.get(f'{base}/api/keys').text()
    assert 'fixture-browser-refresh' not in public and 'fixture-refresh-rotated' not in public
    others = {k['id']: k['usage'] for k in page.request.get(f'{base}/api/keys').json() if k['id'] != key['id']}
    with page.expect_response(lambda r: r.url.endswith(f"/keys/{key['id']}/usage") and r.request.method == 'POST'):
        page.get_by_role('button', name='查询 Browser Keenable 用量', exact=True).click()
    assert others == {k['id']: k['usage'] for k in page.request.get(f'{base}/api/keys').json() if k['id'] != key['id']}

    pending = page.request.post(f'{base}/api/keys', data={'provider': 'keenable', 'label': 'Browser Keenable pending', 'account': 'fixture pending', 'keys': ['keen-browser-pending-12345']}).json()[0]
    page.get_by_role('button', name='刷新数据', exact=True).click()
    expect(page.get_by_text('Browser Keenable pending', exact=True)).to_be_visible()
    for box in page.get_by_role('checkbox', name=re.compile(r'^选择 ')).all():
        box.uncheck()
    page.get_by_role('checkbox', name='选择 Browser Keenable', exact=True).check()
    page.get_by_role('checkbox', name='选择 Browser Keenable pending', exact=True).check()
    page.get_by_role('button', name='批量查询所选用量（2）', exact=True).click()
    expect(page.get_by_text('批量查询完成 · 2 / 2', exact=True)).to_be_visible()
    expect(page.locator('.batch-results')).to_contain_text('成功 1 · 失败 0 · 未支持 / 待配置 1')
    assert page.request.delete(f"{base}/api/keys/{pending['id']}").ok
    page.get_by_role('button', name='刷新数据', exact=True).click()
    expect(page.get_by_text('Browser Keenable pending', exact=True)).not_to_be_visible()

    dialog = open_login()
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-invalid-login')
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog.get_by_role('alert')).to_contain_text('登录已失效', timeout=20000)
    expect(dialog.get_by_label('Refresh token', exact=True)).to_have_value('')
    old = next(k for k in page.request.get(f'{base}/api/keys').json() if k['id'] == key['id'])
    assert old['keenable_login']['needs_login'] and old['usage']['balance']['free_remaining'] == 99988
    assert old['state'] == 'ready'
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-browser-recovery')
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)

    seen = []
    def track(request):
        if request.method == 'PUT' and request.url.endswith('/keenable-session'):
            seen.append(request.url)
    page.on('request', track)
    dialog = open_login()
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    page.remove_listener('request', track)
    assert not seen, 'Blank inputs must retain the saved token pair'
    dialog = open_login()
    page.screenshot(path=str(artifacts / 'keenable-login.png'), full_page=True, animations='disabled')
    page.set_viewport_size({'width': 390, 'height': 844})
    expect(dialog.get_by_role('button', name='保存并查询余额')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(artifacts / 'keenable-login-mobile.png'), full_page=True, animations='disabled')
    page.set_viewport_size({'width': 1440, 'height': 1050})
    dialog.get_by_role('button', name='移除登录凭证').click()
    expect(dialog).not_to_be_visible()
    removed = next(k for k in page.request.get(f'{base}/api/keys').json() if k['id'] == key['id'])
    assert 'keenable_login' not in removed and removed['usage'] is None and removed['state'] == 'ready'
    dialog = open_login()
    dialog.get_by_label('Refresh token', exact=True).fill('fixture-browser-final')
    dialog.get_by_role('button', name='保存并查询余额').click()
    expect(dialog).not_to_be_visible(timeout=20000)
    assert page.request.get(f'{base}/api/dashboard').json()['calls'] == calls
