#import <React/RCTBridgeModule.h>
#import <SDWebImageWebPCoder/SDImageWebPCoder.h>
#import <UIKit/UIKit.h>
#import <ImageIO/ImageIO.h>

@interface NotatoImageCodec : NSObject <RCTBridgeModule>
@end

@implementation NotatoImageCodec
RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_global_queue(QOS_CLASS_UTILITY, 0); }

RCT_REMAP_METHOD(encodeWebP, encodeWebP:(NSString *)base64 resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
    @autoreleasepool {
        if (base64.length > 45 * 1024 * 1024) { resolve(nil); return; }
        NSData *png = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
        if (!png || png.length > 32 * 1024 * 1024) { resolve(nil); return; }
        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)png, NULL);
        NSDictionary *properties = source ? CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)) : nil;
        if (source) CFRelease(source);
        uint64_t width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] unsignedLongLongValue];
        uint64_t height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] unsignedLongLongValue];
        if (width == 0 || height == 0 || width > 16383 || height > 16383 || width * height > 16000000) {
            resolve(nil); return;
        }
        UIImage *image = [UIImage imageWithData:png];
        if (!image || !image.CGImage ||
            (uint64_t)CGImageGetWidth(image.CGImage) * CGImageGetHeight(image.CGImage) > 16000000) {
            resolve(nil);
            return;
        }
        NSData *webp = [[SDImageWebPCoder sharedCoder] encodedDataWithImage:image format:SDImageFormatWebP
            options:@{SDImageCoderEncodeCompressionQuality: @0.85}];
        resolve(webp.length > 0 && webp.length < png.length ? [webp base64EncodedStringWithOptions:0] : nil);
    }
}
@end
