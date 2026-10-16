require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'NotatoImageCodec'
  s.version = package['version']
  s.summary = 'On-device compression of Notato screenshots after privacy masking.'
  s.homepage = 'https://github.com/notatorg/notato'
  s.license = { :type => 'MIT' }
  s.author = 'Notato'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => 'https://github.com/notatorg/notato.git', :tag => "v#{s.version}" }
  s.source_files = 'ios/**/*.{h,m}'
  s.dependency 'React-Core'
  s.dependency 'SDWebImageWebPCoder', '~> 0.14'
  s.dependency 'libwebp', '~> 1.6'
end
