import json
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright,expect

OUT=Path('diagnostics/owner-operations')
OUT.mkdir(parents=True,exist_ok=True)
BASE='http://127.0.0.1:3000/login/qa-owner-operations'
STAMP='2026-09-26T12:00:00Z'
def uid(n):return '11111111-1111-4111-8111-'+str(n).zfill(12)
def empty(section):
    result={'version':1,'section':section,'checked_at':STAMP,'offset':0,'page_size':25,'total':0,'counts':{},'rows':[]}
    if section=='notifications':result['diagnostics']={'notifications_enabled':True,'escalation_enabled':False,'last_scan_at':None}
    return result

def main():
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':390,'height':844})
        errors=[]; writes=[]; mode={'value':'fail'}
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('request',lambda r:writes.append(r.url) if r.method in ('POST','PUT','PATCH','DELETE') else None)
        def handle(route):
            query=parse_qs(urlparse(route.request.url).query)
            section=query.get('section',[''])[0]; offset=int(query.get('offset',['0'])[0])
            if section=='cash' and mode['value']=='fail':
                route.fulfill(status=200,json={'section':section,'status':'unavailable'});return
            data=empty(section)
            if section=='cash':
                count=27 if mode['value']=='pages' else 1
                data.update(total=count,counts={'cash_count':count},offset=offset)
                data['rows']=[{'id':uid(n),'title':f'Recovered box {n}','context':None,'person':'Demo coordinator','state':'cash_count','since':'2026-09-26T09:00:00Z','due_at':None,'href':'/cash-handling?id='+uid(n)} for n in range(offset+1,min(offset+25,count)+1)]
            route.fulfill(status=200,json={'section':section,'status':'ready','data':data})
        page.route('**/api/owner-operations?*',handle)
        try:
            for ar in (False,True):
                page.goto(BASE+('?ar=1&failure=1' if ar else '?failure=1'),wait_until='networkidle')
                root=page.get_by_test_id('owner-operations')
                expect(root).to_have_attribute('dir','rtl' if ar else 'ltr')
                expect(page.get_by_test_id('ops-metric-cash')).to_have_text('2')
                expect(page.get_by_test_id('ops-metric-buying')).to_have_text('—')
                expect(page.get_by_test_id('ops-metric-stocktakes')).to_have_text('1')
                expect(root.get_by_role('alert')).to_contain_text('ليس صفراً' if ar else 'unknown—not zero')
                expect(page.locator('#ops-stocktakes a[href="/inventory/stocktake?id='+uid(6)+'"]')).to_have_count(1)
                expect(page.locator('#ops-cash a[href="/cash-collections/'+uid(3)+'"]')).to_have_count(1)
                for width in (390,320):
                    page.set_viewport_size({'width':width,'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Overflow {ar=} {width=}'
                    root.screenshot(path=str(OUT/f'overview-{("ar" if ar else "en")}-{width}.png'))
                assert page.locator('button').filter(has_text='اعتماد وتسجيل الفرق').count()==0
            page.goto(BASE+'?failure=1',wait_until='networkidle')
            page.get_by_role('button',name='Refresh overview',exact=True).click()
            expect(page.get_by_test_id('ops-metric-cash')).to_have_text('—')
            expect(page.get_by_test_id('ops-metric-buying')).to_have_text('0')
            expect(page.locator('#ops-cash')).to_contain_text('This is not an empty queue.')
            expect(page.locator('#ops-stocktakes')).to_contain_text('No matching records at the last successful check.')
            mode['value']='recover'
            page.locator('#ops-cash').get_by_role('button',name='Retry this section',exact=True).click()
            expect(page.get_by_test_id('ops-metric-cash')).to_have_text('1')
            expect(page.locator('#ops-cash')).to_contain_text('Recovered box 1')
            mode['value']='pages'
            page.get_by_role('button',name='Refresh overview',exact=True).click()
            expect(page.get_by_test_id('ops-metric-cash')).to_have_text('27')
            expect(page.locator('#ops-cash li')).to_have_count(25)
            page.locator('#ops-cash').get_by_role('button',name='Next',exact=True).click()
            expect(page.locator('#ops-cash li')).to_have_count(2)
            expect(page.locator('#ops-cash')).to_contain_text('Recovered box 26')
            expect(page.get_by_test_id('ops-metric-cash')).to_have_text('27')
            page.locator('#ops-cash').get_by_role('button',name='Previous',exact=True).click()
            expect(page.locator('#ops-cash li')).to_have_count(25)
            assert not errors,errors
            assert not writes,writes
            (OUT/'result.json').write_text(json.dumps({'status':'passed','scenarios':['English/Arabic 390/320','unknown vs zero','legacy cash separate','stocktake link','partial refresh failure','retry recovery','25-row pagination','no browser writes'],'browser_errors':errors,'write_requests':writes},indent=2))
        except Exception:
            page.screenshot(path=str(OUT/'failure.png'),full_page=True)
            (OUT/'failure.html').write_text(page.content())
            raise
        finally:browser.close()
    print('PASS: bilingual mobile overview, per-section failure/recovery, real-record links and pagination; no write requests')
main()
