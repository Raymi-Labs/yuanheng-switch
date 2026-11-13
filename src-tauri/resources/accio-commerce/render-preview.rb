require 'json'
def escape(value)
  value.to_s.gsub('&','&amp;').gsub('<','&lt;').gsub('>','&gt;').gsub(/[\\\x60*_{}\[\]()#!|~]/) { |char| "\\" + char }.gsub(/\r?\n/,'<br>')
end
root=File.dirname(File.expand_path(__FILE__))
draft=File.open(File.join(root,'listing-draft.json'),File::RDONLY|File::NOFOLLOW) do |f|
  raise 'invalid draft file' unless f.stat.file? && f.size<=4194304
  JSON.parse(f.read.force_encoding('UTF-8'))
end
lines=['# 商品文案草稿 / Product copy draft','','仅供人工审稿，未上架 / Human review required; not published.','']
draft.fetch('products').each do |p|
  price=p.fetch('price_cny')
  price=price.to_i if price.is_a?(Float) && price==price.to_i
  lines += ['## '+p.fetch('sku'),'','价格 / Price (CNY): '+price.to_s,'','### '+escape(p.fetch('title_zh'))]
  lines += p.fetch('bullets_zh').map { |v| '- '+escape(v) }
  lines += ['','### '+escape(p.fetch('title_en'))]
  lines += p.fetch('bullets_en').map { |v| '- '+escape(v) }
  unknown=p.fetch('missing_information').map { |v| escape(v) }.join(', ')
  lines += ['','待确认字段 / Unknown fields: '+(unknown.empty? ? '—' : unknown),'','### 原始事实核对 / Source facts','','| 字段 / Field | 原值 / Value |','| --- | --- |']
  excluded=%w[title_zh title_en bullets_zh bullets_en missing_information review_status supplier_note]
  (p.keys-excluded).sort.each { |key| lines << '| '+escape(key)+' | '+escape(JSON.generate(p[key]))+' |' }
  lines << ''
end
preview=lines.join("\n")+"\n"
File.open(File.join(root,'listing-draft.md'),File::WRONLY|File::CREAT|File::NOFOLLOW,0600) do |f|
  raise 'invalid output file' unless f.stat.file?
  f.truncate(0); f.write(preview)
end
