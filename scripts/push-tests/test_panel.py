"""Viewport acceptance using real React components with simulated API/device boundaries.
No physical push receipt is claimed. Generates screenshots + assertions for CI.
"""
import json
import os
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
subprocess.run(['node', 'scripts/push-tests/panel-fixture.mjs'], cwd=ROOT, check=True)
OUT = ROOT / '.qa/push-panel/evidence'
OUT.mkdir(exist_ok=True)
HTML = (ROOT / '.qa/push-panel/index.html').read_text()
def load_page(page, params):
    # Fully offline document: browser APIs and fetch are controlled boundaries.
    setup = '<script>window.fixtureParams=' + json.dumps(params) + ';Object.defineProperty(window,"isSecureContext",{value:true});</script>'
    page.set_content(HTML.replace('<head>', '<head>' + setup), wait_until='load')
checks=[]
with sync_playwright() as p:
    kwargs={'headless':True}
    if os.environ.get('CHROMIUM_PATH'): kwargs['executable_path']=os.environ['CHROMIUM_PATH']
    browser=p.chromium.launch(**kwargs)
    for locale in ['en','ar']:
        for width,height in [(320,568),(375,667),(390,844),(430,932),(844,390),(320,280),(1280,800)]:
            page=browser.new_page(viewport={'width':width,'height':height})
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            load_page(page, f'?locale={locale}')
            trigger=page.locator('button[aria-haspopup="dialog"]')
            trigger.click()
            dialog=page.locator('dialog')
            expect(dialog).to_be_visible()
            expect(dialog.get_by_text('مسجل ومسموح له بالإشعارات' if locale=='ar' else 'Registered and permission granted',exact=True)).to_be_visible()
            rect=dialog.bounding_box()
            assert rect['x']>=0 and rect['y']>=0 and rect['x']+rect['width']<=width+1 and rect['y']+rect['height']<=height+1,(locale,width,height,rect)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'page overflow'
            scroll=page.locator('.panel-body')
            assert scroll.evaluate('(e)=>e.scrollWidth<=e.clientWidth'), 'panel horizontal overflow'
            # The test controls remain clickable after scrolling within the panel.
            dialog.get_by_role('button',name='اختبار الآن' if locale=='ar' else 'Test now',exact=True).click()
            assert page.evaluate('testCalls.length')==1
            dialog.get_by_role('button',name='اختبار بعد إغلاق التطبيق' if locale=='ar' else 'Test after closing app',exact=True).click()
            assert page.evaluate('testCalls[1].delaySeconds')==15
            scroll.evaluate('(e)=>e.scrollTop=e.scrollHeight')
            expect(dialog.get_by_role('button',name='إغلاق' if locale=='ar' else 'Close notifications',exact=True)).to_be_in_viewport()
            assert scroll.evaluate('(e)=>e.scrollWidth<=e.clientWidth')
            for _ in range(12):
                page.keyboard.press('Tab')
                assert page.evaluate('document.activeElement === document.body || !!document.activeElement.closest("dialog")'),'background control received focus'
            page.locator('#outside-control').evaluate('(e)=>e.focus()')
            assert not page.locator('#outside-control').evaluate('(e)=>e===document.activeElement')
            page.screenshot(path=str(OUT/f'{locale}-{width}x{height}.png'))
            page.keyboard.press('Escape')
            expect(dialog).not_to_be_visible()
            expect(trigger).to_be_focused()
            trigger.click()
            expect(dialog).to_be_visible()
            page.mouse.click(2,2)
            expect(dialog).not_to_be_visible()
            assert not errors, errors
            checks.append({'locale':locale,'width':width,'height':height,'viewport':'pass','scroll':'pass','focus':'pass','tests':'pass'})
            page.close()
    for locale in ['en','ar']:
        for mode in ['schema','fresh','failure']:
            page=browser.new_page(viewport={'width':320,'height':568})
            load_page(page, f'?locale={locale}&mode={mode}&large=1')
            page.locator('button[aria-haspopup="dialog"]').click()
            dialog=page.locator('dialog')
            enable=dialog.get_by_role('button',name='تفعيل الإشعارات' if locale=='ar' else 'Enable notifications',exact=True)
            if mode=='schema':
                expect(enable).to_be_disabled()
                assert dialog.get_by_role('button',name='Test now',exact=True).count()==0
            elif mode=='fresh':
                expect(enable).to_be_enabled();enable.click()
                expect(dialog.get_by_role('button',name='اختبار الآن' if locale=='ar' else 'Test now',exact=True)).to_be_enabled()
            else:
                dialog.get_by_role('button',name='اختبار الآن' if locale=='ar' else 'Test now',exact=True).click()
                expect(dialog.get_by_text('تعذر توثيق الخادم' if locale=='ar' else 'The server could not authenticate',exact=False)).to_be_visible()
            assert page.locator('.panel-body').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(OUT/f'{locale}-{mode}-large-text.png'))
            checks.append({'locale':locale,'mode':mode,'largeText':'pass','viewport':'pass'})
            page.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps(checks,indent=2))
print(f'PASS: {len(checks)} notification viewport/state scenarios; no real push sent')
