import json
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright,expect

OUT=Path('diagnostics/personal-work')
OUT.mkdir(parents=True,exist_ok=True)
BASE='http://127.0.0.1:3000/login/qa-personal-work'
STAMP='2026-09-26T12:00:00Z'
def uid(n):return '11111111-1111-4111-8111-'+str(n).zfill(12)
def payload(section,view,offset=0):
    result={'version':1,'section':section,'view':view,'status':'ready','checked_at':STAMP,'offset':offset,'page_size':5,'total':0,'actions':0,'totals':{'active':0,'upcoming':0,'history':0},'rows':[]}
    if section=='cash':
        result['totals']={'active':7,'upcoming':0,'history':1}
        result['total']=result['totals'][view];result['actions']=7 if view=='active' else 0
        start=101 if view=='history' else 1
        result['rows']=[{'id':uid(n),'target_id':uid(n),'title':('History box ' if view=='history' else 'Recovered box ')+str(n),'context':None,'state':'cash_done' if view=='history' else 'cash_count','since':'2026-09-26T09:00:00Z','due_at':None,'done':None,'total':None,'rank':9 if view=='history' else 1,'actionable':view!='history'} for n in range(start+offset,start+min(offset+5,result['total']))]
    elif section=='buying' and view=='upcoming':
        result.update(total=1,actions=1,totals={'active':0,'upcoming':1,'history':0})
        result['rows']=[{'id':uid(201),'target_id':uid(201),'title':'Tomorrow shopping','context':'Test store','state':'buying_shop','since':STAMP,'due_at':'2026-09-27T22:00:00Z','done':0,'total':6,'rank':4,'actionable':True}]
    return {'section':section,'view':view,'status':'ready','data':result}

def main():
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':390,'height':844})
        errors=[];writes=[];calls=[];mode={'value':'normal'};held=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('request',lambda req:writes.append(req.url) if req.method in ('POST','PUT','PATCH','DELETE') else None)
        def handle(route):
            q=parse_qs(urlparse(route.request.url).query)
            section=q['section'][0];view=q['view'][0];offset=int(q.get('offset',['0'])[0]);calls.append((section,view,offset))
            if mode['value']=='race' and view=='upcoming':held.append((route,section,view,offset));return
            if mode['value']=='failure' and section=='cash':route.fulfill(status=503,json={'section':section,'view':view,'status':'unavailable'});return
            if mode['value']=='malformed' and section=='cash':route.fulfill(status=200,json={'section':section,'view':view,'status':'ready','data':{'total':0}});return
            route.fulfill(status=200,json=payload(section,view,offset))
        page.route('**/api/personal-work?*',handle)
        try:
            for ar in (False,True):
                page.goto(BASE+('?ar=1&failure=1' if ar else '?failure=1'),wait_until='networkidle')
                root=page.get_by_test_id('personal-work')
                expect(root).to_have_attribute('dir','rtl' if ar else 'ltr')
                expect(root.get_by_role('heading',level=1)).to_have_text('مهامي اليوم' if ar else 'My Work Today')
                expect(root.get_by_test_id('my-count-cash')).to_have_text('7')
                expect(root.get_by_test_id('my-count-buying')).to_have_text('—')
                expect(root.get_by_role('alert')).to_contain_text('ليست صفراً' if ar else 'unknown—not zero')
                panel=root.locator('section')
                expect(panel.locator('li')).to_have_count(5)
                expect(panel.locator('a').first).to_have_attribute('href','/cash-handling?id='+uid(1))
                for width in (390,320):
                    page.set_viewport_size({'width':width,'height':844})
                    root.locator('header').scroll_into_view_if_needed()
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Overflow {ar=} {width=}'
                    page.screenshot(path=str(OUT/f'overview-{"ar" if ar else "en"}-{width}.png'))
                    for section,label in [('cash','علب النقد' if ar else 'Cash boxes'),('buying','قوائم الشراء' if ar else 'Shopping lists'),('storage','وضع البضاعة' if ar else 'Place in storage'),('stocktakes','جرد المخزن' if ar else 'Storage counts')]:
                        root.get_by_role('button',name=label,exact=True).click()
                        panel.locator('h2').scroll_into_view_if_needed()
                        expect(panel.locator('h2')).to_be_in_viewport()
                        assert panel.evaluate('(el)=>Array.from(el.querySelectorAll("li,a,button,p")).every(x=>{const r=x.getBoundingClientRect();return r.left>=-2&&r.right<=innerWidth+2})'),f'Clipped {section} {ar=} {width=}'
                        page.screenshot(path=str(OUT/f'{section}-{"ar" if ar else "en"}-{width}.png'))
                expect(panel).to_contain_text('بانتظار مراجعة المالك' if ar else 'waiting for owner review')
                expect(panel.get_by_text('متأخر' if ar else 'Overdue',exact=True)).to_have_count(0)
                expect(panel.locator('a[href="/inventory/stocktake?id='+uid(42)+'"]')).to_have_text('عرض السجل' if ar else 'View record')
                expect(root.locator('button').filter(has_text='Approve')).to_have_count(0)
            page.goto(BASE+'?failure=1',wait_until='networkidle');root=page.get_by_test_id('personal-work');panel=root.locator('section')
            mode['value']='failure'
            root.get_by_role('button',name='Refresh all work',exact=True).click()
            expect(root.get_by_test_id('my-count-cash')).to_have_text('—')
            expect(root.get_by_test_id('my-count-buying')).to_have_text('0')
            expect(panel).to_contain_text('This is not an empty task list.')
            mode['value']='normal'
            root.get_by_role('button',name='Retry this section',exact=True).click()
            expect(root.get_by_test_id('my-count-cash')).to_have_text('7')
            expect(panel.locator('li')).to_have_count(5)
            root.get_by_role('button',name='Next',exact=True).click()
            expect(panel.locator('li')).to_have_count(2)
            expect(panel).to_contain_text('Recovered box 6')
            expect(root.get_by_test_id('my-count-cash')).to_have_text('7')
            root.get_by_role('button',name='Previous',exact=True).click()
            expect(panel.locator('li')).to_have_count(5)
            root.get_by_role('button',name='Upcoming',exact=True).click()
            expect(root.get_by_test_id('my-count-buying')).to_have_text('1')
            root.get_by_role('button',name='Shopping lists',exact=True).click()
            expect(panel).to_contain_text('Tomorrow shopping')
            root.get_by_role('button',name='History',exact=True).click()
            expect(root.get_by_test_id('my-count-cash')).to_have_text('1')
            root.get_by_role('button',name='Cash boxes',exact=True).click()
            expect(panel).to_contain_text('History box 101')
            expect(panel.get_by_role('link',name='View record',exact=True)).to_have_count(1)
            # Delayed cancelled requests must never replace the newly selected view.
            mode['value']='race';root.get_by_role('button',name='Upcoming',exact=True).click()
            page.wait_for_function('document.querySelector("[data-testid=my-count-cash]").textContent==="…"')
            root.get_by_role('button',name='Active',exact=True).click()
            expect(root.get_by_test_id('my-count-cash')).to_have_text('7')
            for route,section,view,offset in held:
                try:route.fulfill(status=200,json=payload(section,view,offset))
                except Exception:pass # Aborted by the application, as expected.
            expect(root.get_by_test_id('my-count-cash')).to_have_text('7')
            expect(panel).to_contain_text('Recovered box 1')
            mode['value']='malformed';root.get_by_role('button',name='Refresh all work',exact=True).click()
            expect(root.get_by_test_id('my-count-cash')).to_have_text('—')
            expect(panel).to_contain_text('This is not an empty task list.')
            assert not errors,errors
            assert not writes,writes
            assert all(len(c)==3 for c in calls)
            (OUT/'result.json').write_text(json.dumps({'status':'passed','scenarios':['English/Arabic 390/320px','only five cards per page','independent partial failure','retry','5-row paging','upcoming and history','waiting stock review has no approve or overdue','original-record links','stale-request cancellation','malformed not zero','no browser writes'],'browser_errors':errors,'write_requests':writes},indent=2))
        except Exception:
            page.screenshot(path=str(OUT/'failure.png'),full_page=True)
            (OUT/'failure.html').write_text(page.content())
            raise
        finally:browser.close()
    print('PASS: My Work Today component browser acceptance; synthetic fixtures, no production access')
main()
