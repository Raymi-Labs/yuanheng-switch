import Foundation
import Security
import Photos
import Tauri

struct SessionArgs: Decodable { let value: String }
struct ImageArgs: Decodable { let data: String; let mime: String }

class YuanhengPlugin: Plugin {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.nanashiwang.yuanhengmobile",
         kSecAttrAccount as String: "session-v1"]
    }
    @objc public func readSession(_ invoke: Invoke) throws {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { invoke.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            invoke.reject("无法读取安全存储"); return
        }
        invoke.resolve(["value": value])
    }
    @objc public func writeSession(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SessionArgs.self)
        guard args.value.utf8.count <= 16384, let data = args.value.data(using: .utf8) else { invoke.reject("会话无效"); return }
        let values: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil)
        }
        if status == errSecSuccess { invoke.resolve() } else { invoke.reject("无法保存登录状态") }
    }
    @objc public func clearSession(_ invoke: Invoke) throws {
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { invoke.resolve() } else { invoke.reject("无法清除登录状态") }
    }
    @objc public func saveImage(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ImageArgs.self)
        guard ["image/png", "image/jpeg", "image/webp"].contains(args.mime),
              let data = Data(base64Encoded: args.data), !data.isEmpty, data.count <= 32 * 1024 * 1024 else {
            invoke.reject("图片格式无效"); return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else { invoke.reject("请允许元衡向相册添加图片"); return }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
            }) { success, _ in
                if success { invoke.resolve() } else { invoke.reject("图片保存失败") }
            }
        }
    }
}
@_cdecl("init_plugin_yuanheng_native")
func initPlugin() -> Plugin { YuanhengPlugin() }
