// provider 文件解析:节点名 -> 落地地址。跑法 node test/provider-egress.mjs
import assert from 'node:assert/strict';
import { parseProviderEgress } from '../server/config.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

// 实测机场就是这个形状:一行一条 flow 风格 JSON
ok('flow 风格', () => {
  const m = parseProviderEgress([
    'proxies:',
    '- {"name":"香港 01","server":"31.58.50.200","port":8443,"type":"vless"}',
    '- {"name":"香港 02","server":"31.58.50.200","port":8443,"type":"vless"}',
    '- {"name":"日本 01","server":"1.2.3.4","port":443,"type":"trojan"}',
  ].join('\n'));
  assert.equal(m.size, 3);
  assert.equal(m.get('香港 01'), '31.58.50.200');
  assert.equal(m.get('香港 02'), '31.58.50.200');
  assert.equal(m.get('日本 01'), '1.2.3.4');
});

ok('块风格多行', () => {
  const m = parseProviderEgress([
    'proxies:',
    '  - name: A',
    '    server: 10.0.0.1',
    '    port: 443',
    '  - name: B',
    '    server: 10.0.0.1',
    '    port: 8443',
  ].join('\n'));
  assert.equal(m.get('A'), '10.0.0.1');
  assert.equal(m.get('B'), '10.0.0.1');
});

// servername/username 不能污染 server/name
ok('不误取相似字段', () => {
  const m = parseProviderEgress(
    '- {"name":"X","servername":"cdn.example.com","server":"9.9.9.9","username":"u"}',
  );
  assert.equal(m.size, 1);
  assert.equal(m.get('X'), '9.9.9.9');
});

ok('单引号与无引号', () => {
  const m = parseProviderEgress("- {name: 'Y', server: 8.8.8.8, port: 443}");
  assert.equal(m.get('Y'), '8.8.8.8');
});

ok('域名落地照样收', () => {
  const m = parseProviderEgress('- {"name":"Z","server":"a.example.com"}');
  assert.equal(m.get('Z'), 'a.example.com');
});

ok('缺字段的条目跳过', () => {
  const m = parseProviderEgress([
    '- {"name":"NoServer","port":443}',
    '- {"server":"1.1.1.1","port":443}',
    '- {"name":"Good","server":"2.2.2.2"}',
  ].join('\n'));
  assert.deepEqual([...m.keys()], ['Good']);
});

ok('空输入不炸', () => {
  assert.equal(parseProviderEgress('').size, 0);
  assert.equal(parseProviderEgress(null).size, 0);
  assert.equal(parseProviderEgress(undefined).size, 0);
});

ok('名字里有转义引号', () => {
  const m = parseProviderEgress('- {"name":"a\\"b","server":"3.3.3.3"}');
  assert.equal(m.get('a"b'), '3.3.3.3');
});

console.log(`\nprovider-egress: ${n} 项通过`);
