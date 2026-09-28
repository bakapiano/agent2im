import { test, expect } from '@playwright/test';
test('administrator configures channel and explicitly approves and revokes isolated user',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
  await page.getByLabel('首次设置令牌').fill('browser-bootstrap-fixture');await page.getByLabel('管理员密码').fill('browser-password-fixture');await page.getByRole('button',{name:'进入控制台'}).click();
  await expect(page.getByRole('button',{name:'添加飞书渠道'})).toBeVisible();
  await page.getByRole('tab',{name:/访问审批/}).click();await page.getByRole('button',{name:'审阅'}).click();await expect(page.getByText('im:',{exact:false}).first()).toBeVisible();
  await page.getByRole('button',{name:'允许此用户互动'}).click();await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeEnabled();
  await page.getByRole('tab',{name:'渠道与连接'}).click();await expect(page.getByText(/^dm-/)).toBeVisible();
  await page.getByRole('button',{name:'添加飞书渠道'}).click();await page.getByLabel('渠道别名').fill('second-fixture');await page.getByLabel('显示名称').fill('浏览器验收渠道');await page.getByLabel('App ID',{exact:true}).fill('cli_browserfixture');await page.getByLabel('App Secret（保存时加密）').fill('browser-secret-fixture');await page.getByRole('button',{name:'仅保存凭据引用'}).click();await expect(page.getByText(/凭据引用：/)).toBeVisible();await expect(page.getByLabel('App Secret（保存时加密）')).toHaveValue('');await page.getByRole('button',{name:'保存渠道',exact:true}).click();
  const row=page.getByRole('row').filter({hasText:'浏览器验收渠道'});await expect(row).toBeVisible();await row.getByRole('button',{name:'验证',exact:true}).click();await expect(row.getByText('validated',{exact:true})).toBeVisible();await row.getByRole('button',{name:'启用',exact:true}).click();await expect(row.getByText('enabled',{exact:true})).toBeVisible();
  await page.screenshot({path:'.test-data/portal-channels.png',fullPage:true});
  await page.getByRole('tab',{name:/访问审批/}).click();await page.getByRole('button',{name:'撤销',exact:true}).click();await page.getByRole('button',{name:'OK',exact:true}).click();await expect(page.getByText('revoked',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'退出',exact:true}).click();await expect(page.getByLabel('管理员密码')).toBeVisible();await page.getByLabel('管理员密码').fill('browser-password-fixture');await page.getByRole('button',{name:'进入控制台'}).click();await expect(page.getByRole('button',{name:'添加飞书渠道'})).toBeVisible();expect(errors).toEqual([]);
});
