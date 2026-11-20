// Filming sprints inside the app, with the Freelap times on the video (Stanley, 2026-11-13: "sprint
// tab, keď natáčaš a je zapnutý Freelap, nech sa to pridá priamo do videa ako overlay").
//
// The recorder films at 120 fps. While it films, the web page passes every Freelap run it hears
// (SprintCamera.run) and the recorder notes when it arrived. A chip broadcasts its run right after
// the finish, so the finish moment is "arrival minus a short radio delay", and the start is the
// finish minus the lap time. After Stop the video is written again with the overlay burned in: a
// ring timer running from the start crossing (as OVR Sprint shows it), each leg as it is passed,
// and the final time held. The overlay is placed by that estimate, so it can be a frame or two off;
// the times themselves are Freelap's own.
//
// The video stays at 120 fps and plays at normal speed in Photos, like the Camera app's 120 fps
// clips (Stanley: "keď nahrám 120 fps video, v galérii ide full speed"). What tells Photos that is a
// QuickTime metadata item, full-frame-rate-playback-intent = 1; without it a 120 fps clip is shown
// as slow motion.
import UIKit
import AVFoundation
import Photos
import CoreImage
import Capacitor
import PhotosUI
import UniformTypeIdentifiers
import CoreBluetooth

/// The app's root view controller: Capacitor plus the app's own plugin.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SprintCameraPlugin())
    }
}

/// One Freelap run, as the overlay needs it.
struct SprintRun {
    let key: String
    var name: String
    var lap: Double
    var legs: [Double]
    var arrived: Double   // seconds after the recording started when the run reached the phone
}

@objc(SprintCameraPlugin)
public class SprintCameraPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SprintCamera"
    public let jsName = "SprintCamera"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "run", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finalize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "viewCopy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trimJump", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trimRange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
    ]
    private weak var recorder: RecorderViewController?
    private var galleryDelegate: GalleryPickerDelegate?

    /// Videos straight from Photos as the original files (HEVC at the filmed 120 or 240 fps), with no
    /// detour through Files (Stanley 2026-11-16: "rád by som obišiel krok nahrať súbor, len z
    /// galérie"). The web file input hands over a re-encoded copy without the slow-motion frames;
    /// PHPicker with the .current representation gives the asset as it is. Resolves
    /// { files: [{ path, name }] }, empty when the picker is closed.
    /// The screen stays on while uploads or analyses are on their way (2026-11-19: the phone locked,
    /// iOS paused the app, and three of five run-ups waited half an hour to be sent).
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve(["on": on])
        }
    }

    @objc func pickVideo(_ call: CAPPluginCall) {
        let limit = max(0, call.getInt("limit") ?? 1)
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("No view"); return }
            var cfg = PHPickerConfiguration(photoLibrary: .shared())
            cfg.filter = .videos
            cfg.selectionLimit = limit
            cfg.preferredAssetRepresentationMode = .current
            let picker = PHPickerViewController(configuration: cfg)
            let d = GalleryPickerDelegate(call: call) { [weak self] in self?.galleryDelegate = nil }
            self.galleryDelegate = d
            picker.delegate = d
            host.present(picker, animated: true)
        }
    }

    /// A copy for watching (2026-11-18, Stanley: "ako pretáčať video aby nesekalo"). The camera
    /// writes a keyframe every 116 frames at 120 fps, so a frame-exact seek decodes up to 115
    /// frames; this copy is H.264 with a keyframe every 4 frames and no B-frames, the same frame
    /// rate and size, about the original's bytes. Resolves { path, ms }.
    @objc func viewCopy(_ call: CAPPluginCall) {
        guard let p = call.getString("path") else { call.reject("No path"); return }
        let src = p.hasPrefix("file://") ? (URL(string: p) ?? URL(fileURLWithPath: p)) : URL(fileURLWithPath: p)
        let dst = FileManager.default.temporaryDirectory.appendingPathComponent("view-\(UUID().uuidString).mp4")
        let t0 = CACurrentMediaTime()
        ViewCopy.make(src, to: dst) { err in
            if let err = err { call.reject(err) } else { call.resolve(["path": dst.path, "ms": Int((CACurrentMediaTime() - t0) * 1000)]) }
        }
    }

    /// The drop jump alone (2026-11-18, Stanley: "prečo ho neorezať predtým ako ho pošleš na
    /// server"): a clip over 3.5 s is cut to 1.8 s before its biggest motion (the rebound and its
    /// landing) and 1.0 s after, written like the watching copy. Standing still is all that is cut;
    /// the server measures the rest, and the app sends the whole clip when no jump comes back.
    /// Resolves { path, from, to, dur, ms } or { trimmed: false, dur }.
    @objc func trimJump(_ call: CAPPluginCall) {
        guard let p = call.getString("path") else { call.reject("No path"); return }
        let src = p.hasPrefix("file://") ? (URL(string: p) ?? URL(fileURLWithPath: p)) : URL(fileURLWithPath: p)
        let t0 = CACurrentMediaTime()
        DispatchQueue.global(qos: .userInitiated).async {
            guard let w = JumpWindow.find(src) else { call.resolve(["trimmed": false]); return }
            if !w.cut { call.resolve(["trimmed": false, "dur": w.dur]); return }
            let dst = FileManager.default.temporaryDirectory.appendingPathComponent("jump-\(UUID().uuidString).mp4")
            ViewCopy.make(src, to: dst, range: CMTimeRange(start: CMTime(seconds: w.from, preferredTimescale: 600), end: CMTime(seconds: w.to, preferredTimescale: 600))) { err in
                if let err = err { call.reject(err) }
                else { call.resolve(["trimmed": true, "path": dst.path, "from": w.from, "to": w.to, "dur": w.dur, "ms": Int((CACurrentMediaTime() - t0) * 1000)]) }
            }
        }
    }

    /// A stretch of a clip by time (from, to in s of the clip), written like the watching copy. A
    /// sprint filmed with Freelap on is cut to its timed stretch before the upload (2026-11-18,
    /// Stanley: "orezanie videa predtým ako ide na server"). Resolves { path, from, to, ms }.
    @objc func trimRange(_ call: CAPPluginCall) {
        guard let p = call.getString("path"), let from = call.getDouble("from"), let to = call.getDouble("to"), to > from else { call.reject("No path or range"); return }
        let src = p.hasPrefix("file://") ? (URL(string: p) ?? URL(fileURLWithPath: p)) : URL(fileURLWithPath: p)
        let t0 = CACurrentMediaTime()
        let dst = FileManager.default.temporaryDirectory.appendingPathComponent("cut-\(UUID().uuidString).mp4")
        let a = max(0, from)
        ViewCopy.make(src, to: dst, range: CMTimeRange(start: CMTime(seconds: a, preferredTimescale: 600), end: CMTime(seconds: to, preferredTimescale: 600))) { err in
            if let err = err { call.reject(err) }
            else { call.resolve(["path": dst.path, "from": a, "to": to, "ms": Int((CACurrentMediaTime() - t0) * 1000)]) }
        }
    }

    /// Opens the recorder over the app. freelap: whether the chips are being listened to.
    @objc func open(_ call: CAPPluginCall) {
        let fps = call.getInt("fps") ?? 120
        let freelapOn = call.getBool("freelap") ?? false
        let chips = (call.getObject("chips") ?? [:]).compactMapValues { $0 as? String }
        let mode = call.getString("mode") ?? "sprint"
        RsiHold.shared.notify = { [weak self] name, data in self?.notifyListeners(name, data: data) }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("No view"); return }
            let vc = RecorderViewController(fps: fps, freelapOn: freelapOn, chips: chips, mode: mode)
            vc.onEvent = { [weak self] name, data in self?.notifyListeners(name, data: data) }
            vc.modalPresentationStyle = .overFullScreen   // keeps the web page in the window, so it keeps running
            host.present(vc, animated: true)
            self.recorder = vc
            call.resolve()
        }
    }

    /// RSI: the analysis is back. marks: [{ from, to, title, big, small }] in seconds of the clip;
    /// empty saves the clip as filmed. The held clip is written to Photos once, with them.
    @objc func finalize(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("No id"); return }
        let marks: [SprintBurner.Mark] = (call.getArray("marks") ?? []).compactMap { v in
            guard let m = v as? [String: Any], let from = (m["from"] as? NSNumber)?.doubleValue, let to = (m["to"] as? NSNumber)?.doubleValue else { return nil }
            return SprintBurner.Mark(from: from, to: to, title: m["title"] as? String ?? "", big: m["big"] as? String ?? "", small: m["small"] as? String ?? "", hud: SprintBurner.Hud(m["hud"]))
        }
        RsiHold.shared.notify = { [weak self] name, data in self?.notifyListeners(name, data: data) }
        RsiHold.shared.finalize(id: id, marks: marks)
        call.resolve()
    }

    /// "Video z tréningu": the finished video from the server (url, bearer auth) into Photos.
    @objc func saveVideo(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else { call.reject("No url"); return }
        var req = URLRequest(url: url)
        if let a = call.getString("auth"), !a.isEmpty { req.setValue("Bearer \(a)", forHTTPHeaderField: "Authorization") }
        URLSession.shared.downloadTask(with: req) { tmp, resp, err in
            guard let tmp = tmp, (resp as? HTTPURLResponse)?.statusCode == 200 else { call.reject(err?.localizedDescription ?? "Video sa nepodarilo stiahnuť"); return }
            let dst = FileManager.default.temporaryDirectory.appendingPathComponent("trening-\(Int(Date().timeIntervalSince1970)).mp4")
            try? FileManager.default.removeItem(at: dst)
            do { try FileManager.default.moveItem(at: tmp, to: dst) } catch { call.reject("Video sa nepodarilo uložiť"); return }
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                guard status == .authorized || status == .limited else { try? FileManager.default.removeItem(at: dst); call.reject("Appka nemá prístup k Fotkám"); return }
                PHPhotoLibrary.shared().performChanges({ PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: dst, options: nil) }) { ok, e in
                    try? FileManager.default.removeItem(at: dst)
                    if ok { call.resolve(["saved": true]) } else { call.reject(e?.localizedDescription ?? "Video sa nepodarilo uložiť") }
                }
            }
        }.resume()
    }

    /// A Freelap run: a new one, or the same run again with its intermediate.
    @objc func run(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? UUID().uuidString
        let name = call.getString("name") ?? ""
        let lap = call.getDouble("lap") ?? 0
        let legs: [Double] = (call.getArray("legs") ?? []).compactMap { v in
            if let n = v as? NSNumber { return n.doubleValue }
            return v as? Double
        }
        DispatchQueue.main.async {
            self.recorder?.takeRun(key: key, name: name, lap: lap, legs: legs)
            call.resolve()
        }
    }
}

// MARK: - The overlay

enum SprintOverlay {
    /// The radio delay between the finish crossing and the run reaching the phone. Not measured yet:
    /// to be set from a clip where the finish crossing can be seen.
    static let latency = 0.2

    static let blue = UIColor(red: 0.20, green: 0.71, blue: 0.94, alpha: 1)
    static let green = UIColor(red: 0.24, green: 0.86, blue: 0.59, alpha: 1)

    /// One frame of the ring timer (Stanley, 2026-11-13: the ring fills once, from the start to
    /// the finish, not round and round; it is on screen the whole time while filming).
    struct State: Equatable {
        var name: String
        var clock: Double        // seconds, to the hundredth
        var progress: Double     // 0 at the start, 1 at the finish
        var marks: [Double]      // where the intermediates sit on the ring (share of the run)
        var legs: [Double]       // the legs passed so far (all of them once finished)
        var final: Bool
        var idle: Bool           // waiting: empty ring, 0,00
        var flash: Double = 0    // 1 right at the finish, fading to 0
        var key: String {
            "\(name)|\(clock)|\((progress * 400).rounded())|\(marks)|\(legs)|\(final)|\(idle)|\((flash * 10).rounded())"
        }

        static func waiting(_ name: String = "") -> State {
            State(name: name, clock: 0, progress: 0, marks: [], legs: [], final: false, idle: true)
        }
        static func finished(_ name: String, lap: Double, legs: [Double], progress: Double = 1) -> State {
            State(name: name, clock: lap, progress: progress, marks: marks(legs, lap), legs: legs.count > 1 ? legs : [], final: progress >= 1, idle: false)
        }
        static func marks(_ legs: [Double], _ lap: Double) -> [Double] {
            guard lap > 0, legs.count > 1 else { return [] }
            var acc = 0.0
            return legs.dropLast().map { acc += $0; return acc / lap }
        }
    }

    static func sec(_ x: Double) -> String { String(format: "%.2f", x).replacingOccurrences(of: ".", with: ",") }

    /// What the ring shows at video time t: waiting until the first run starts, then the run in
    /// progress (the ring fills with the elapsed share of the lap and closes at the finish), then
    /// the result held until the next run starts. nil when no run was heard: the video stays clean.
    static func state(at t: Double, runs: [SprintRun]) -> State? {
        let sorted = runs.sorted { $0.arrived < $1.arrived }
        guard let first = sorted.first else { return nil }
        var shown = State.waiting(first.name)
        for r in sorted {
            let finish = r.arrived - latency, start = finish - r.lap
            if t < start { break }
            if t < finish {
                let el = floor((t - start) * 100) / 100
                var acc = 0.0, done: [Double] = []
                for l in r.legs.dropLast() { acc += l; if el >= acc { done.append(l) } }
                shown = State(name: r.name, clock: el, progress: max(0, min(1, (t - start) / r.lap)),
                              marks: State.marks(r.legs, r.lap), legs: done, final: false, idle: false)
            } else {
                shown = State.finished(r.name, lap: r.lap, legs: r.legs)
                shown.flash = max(0, 1 - (t - finish) / 0.5)
            }
        }
        return shown
    }

    private static func rounded(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        let desc = base.fontDescriptor.withDesign(.rounded) ?? base.fontDescriptor
        let font = UIFont(descriptor: desc, size: size)
        let mono = font.fontDescriptor.addingAttributes([.featureSettings: [[
            UIFontDescriptor.FeatureKey.type: kNumberSpacingType, UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector]]])
        return UIFont(descriptor: mono, size: size)
    }

    /// The ring timer: a dark disc, a thin track with a tick at each intermediate, the progress arc
    /// from the top (blue while running, green once closed at the finish), the time in the middle
    /// with the athlete above it, and the legs as pills under the disc. The pill row is always
    /// reserved, so the disc never moves when they appear. d is the disc's diameter.
    static func image(_ s: State, diameter d: CGFloat, scale: CGFloat) -> UIImage {
        let line = d * 0.07
        let timeFont = rounded(d * 0.25, .bold)
        let nameFont = rounded(d * 0.08, .heavy)
        let unitFont = rounded(d * 0.085, .semibold)
        let pillFont = rounded(d * 0.095, .bold)
        let labelFont = rounded(d * 0.07, .semibold)
        let accent = s.final ? green : blue

        let pills: [NSAttributedString] = s.legs.enumerated().map { i, l in
            let t = NSMutableAttributedString(string: "\(i + 1). úsek  ", attributes: [.font: labelFont, .foregroundColor: UIColor(white: 1, alpha: 0.6)])
            t.append(NSAttributedString(string: sec(l), attributes: [.font: pillFont, .foregroundColor: UIColor.white]))
            return t
        }
        let pillPadX = d * 0.07, pillH = d * 0.16, pillGap = d * 0.035, rowGap = d * 0.06
        let pillWidths = pills.map { $0.size().width + pillPadX * 2 }
        let pillsWidth = pillWidths.reduce(0, +) + pillGap * CGFloat(max(0, pills.count - 1))
        let width = max(d, pillsWidth)
        let height = d + rowGap + pillH

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: ceil(width), height: ceil(height)), format: format).image { _ in
            let c = CGPoint(x: width / 2, y: d / 2), r = d / 2 - line / 2 - d * 0.02
            let disc = UIBezierPath(ovalIn: CGRect(x: c.x - d / 2, y: 0, width: d, height: d))
            UIColor(white: 0, alpha: 0.55).setFill()
            disc.fill()
            if s.flash > 0 { green.withAlphaComponent(0.35 * s.flash).setFill(); disc.fill() }

            let track = UIBezierPath(arcCenter: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: true)
            track.lineWidth = line
            UIColor(white: 1, alpha: 0.16).setStroke()
            track.stroke()
            if s.progress > 0 {
                let end = -CGFloat.pi / 2 + .pi * 2 * CGFloat(min(1, s.progress))
                let arc = UIBezierPath(arcCenter: c, radius: r, startAngle: -.pi / 2, endAngle: end, clockwise: true)
                arc.lineWidth = line
                arc.lineCapStyle = s.progress >= 1 ? .butt : .round
                accent.setStroke()
                arc.stroke()
            }
            for m in s.marks {   // a tick across the track at each intermediate
                let a = -CGFloat.pi / 2 + .pi * 2 * CGFloat(m)
                let tick = UIBezierPath()
                tick.move(to: CGPoint(x: c.x + cos(a) * (r - line * 0.75), y: c.y + sin(a) * (r - line * 0.75)))
                tick.addLine(to: CGPoint(x: c.x + cos(a) * (r + line * 0.75), y: c.y + sin(a) * (r + line * 0.75)))
                tick.lineWidth = d * 0.012
                tick.lineCapStyle = .round
                UIColor.white.setStroke()
                tick.stroke()
            }

            let dim = UIColor(white: 1, alpha: s.idle ? 0.45 : 1)
            let label = s.name.isEmpty ? (s.idle ? "FREELAP" : "") : s.name.uppercased()
            let name = NSAttributedString(string: label, attributes: [.font: nameFont, .foregroundColor: s.idle ? UIColor(white: 1, alpha: 0.55) : accent, .kern: d * 0.012])
            let time = NSAttributedString(string: sec(s.clock), attributes: [.font: timeFont, .foregroundColor: dim])
            let unit = NSAttributedString(string: "s", attributes: [.font: unitFont, .foregroundColor: UIColor(white: 1, alpha: s.idle ? 0.35 : 0.7)])
            let ts = time.size(), ns = name.size(), us = unit.size()
            time.draw(at: CGPoint(x: c.x - ts.width / 2, y: c.y - ts.height / 2))
            name.draw(at: CGPoint(x: c.x - ns.width / 2, y: c.y - ts.height / 2 - ns.height * 0.9))
            unit.draw(at: CGPoint(x: c.x - us.width / 2, y: c.y + ts.height / 2 - us.height * 0.2))

            var x = (width - pillsWidth) / 2
            let y = d + rowGap
            for (p, w) in zip(pills, pillWidths) {
                UIColor(white: 0, alpha: 0.6).setFill()
                UIBezierPath(roundedRect: CGRect(x: x, y: y, width: w, height: pillH), cornerRadius: pillH / 2).fill()
                let ps = p.size()
                p.draw(at: CGPoint(x: x + (w - ps.width) / 2, y: y + (pillH - ps.height) / 2))
                x += w + pillGap
            }
        }
    }
}

// MARK: - Writing the video again with the overlay burned in

enum SprintBurner {
    /// Marks a high frame rate clip to play at normal speed, as the Camera app does.
    static var fullSpeed: AVMetadataItem {
        let item = AVMutableMetadataItem()
        item.keySpace = .quickTimeMetadata
        item.key = "com.apple.quicktime.full-frame-rate-playback-intent" as NSString
        item.value = 1 as NSNumber
        item.dataType = kCMMetadataBaseDataType_SInt8 as String
        return item
    }

    /// A label shown from `from` to `to` seconds into the clip: a small title, a big number, a line under it.
    struct Mark { let from: Double; let to: Double; let title: String; let big: String; let small: String; var hud: Hud? = nil }

    /// The scoreboard (2026-11-14, Stanley: "takto overlay"): the height in a tile on the left, the
    /// contact on the right, the RSI in a ring in the middle (full = the best rebound), a line above.
    struct Hud {
        struct Tile { let cap: String; let v: String; let u: String }
        let top: String; let left: Tile?; let right: Tile?; let ringV: String; let ringU: String; let fill: CGFloat; let best: Bool
        init?(_ any: Any?) {
            guard let d = any as? [String: Any] else { return nil }
            let tile = { (x: Any?) -> Tile? in (x as? [String: Any]).map { Tile(cap: $0["cap"] as? String ?? "", v: $0["v"] as? String ?? "", u: $0["u"] as? String ?? "") } }
            let ring = d["ring"] as? [String: Any] ?? [:]
            top = d["top"] as? String ?? ""; left = tile(d["left"]); right = tile(d["right"])
            ringV = ring["v"] as? String ?? ""; ringU = ring["u"] as? String ?? ""
            fill = CGFloat(max(0, min(1, (ring["fill"] as? NSNumber)?.doubleValue ?? 0))); best = ring["best"] as? Bool ?? false
        }
    }

    static func hudImage(_ h: Hud, width w: CGFloat) -> UIImage {
        // no line above the ring (Stanley, 2026-11-14: „3. odraz z 5 netreba“)
        let d = w * 0.36, topH: CGFloat = 0, H = d, f = UIGraphicsImageRendererFormat.default(); f.scale = 1
        let rounded = { (size: CGFloat, weight: UIFont.Weight) -> UIFont in
            let base = UIFont.systemFont(ofSize: size, weight: weight)
            return base.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? base
        }
        let center = NSMutableParagraphStyle(); center.alignment = .center
        let text = { (s: String, size: CGFloat, weight: UIFont.Weight, alpha: CGFloat, r: CGRect) in
            NSAttributedString(string: s, attributes: [.font: rounded(size, weight), .foregroundColor: UIColor(white: 1, alpha: alpha), .paragraphStyle: center]).draw(in: r)
        }
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: H), format: f).image { ctx in
            if topH > 0, !h.top.isEmpty {
                let shadow = NSShadow(); shadow.shadowColor = UIColor(white: 0, alpha: 0.6); shadow.shadowBlurRadius = topH * 0.25
                NSAttributedString(string: h.top, attributes: [.font: rounded(topH * 0.62, .bold), .foregroundColor: UIColor.white, .paragraphStyle: center, .shadow: shadow])
                    .draw(in: CGRect(x: 0, y: 0, width: w, height: topH))
            }
            // the ring
            let c = CGPoint(x: w / 2, y: topH + d / 2), lw = d * 0.07, r = d / 2 - lw / 2
            UIColor(white: 0, alpha: 0.55).setFill(); UIBezierPath(arcCenter: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: true).fill()
            let track = UIBezierPath(arcCenter: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: true)
            track.lineWidth = lw; UIColor(white: 1, alpha: 0.25).setStroke(); track.stroke()
            if h.fill > 0 {
                let arc = UIBezierPath(arcCenter: c, radius: r, startAngle: -.pi / 2, endAngle: -.pi / 2 + .pi * 2 * h.fill, clockwise: true)
                arc.lineWidth = lw; arc.lineCapStyle = .round
                (h.best ? SprintOverlay.green : UIColor(red: 0.35, green: 0.72, blue: 0.94, alpha: 1)).setStroke(); arc.stroke()
            }
            text(h.ringV, d * 0.27, .heavy, 1, CGRect(x: c.x - d / 2, y: c.y - d * 0.24, width: d, height: d * 0.34))
            text(h.ringU, d * 0.09, .bold, 0.8, CGRect(x: c.x - d * 0.4, y: c.y + d * 0.11, width: d * 0.8, height: d * 0.14))
            // the tiles either side, centred on the ring
            let tw = w * 0.24, th = d * 0.58, ty = c.y - th / 2
            for (t, x) in [(h.left, w * 0.03), (h.right, w - w * 0.03 - tw)] {
                guard let t = t else { continue }
                let rect = CGRect(x: x, y: ty, width: tw, height: th)
                UIColor(white: 0, alpha: 0.55).setFill(); UIBezierPath(roundedRect: rect, cornerRadius: th * 0.2).fill()
                text(t.cap.uppercased(), th * 0.13, .bold, 0.75, CGRect(x: x, y: ty + th * 0.08, width: tw, height: th * 0.2))
                text(t.v, th * 0.34, .heavy, 1, CGRect(x: x, y: ty + th * 0.27, width: tw, height: th * 0.45))
                text(t.u, th * 0.14, .semibold, 0.8, CGRect(x: x, y: ty + th * 0.7, width: tw, height: th * 0.2))
            }
        }
    }

    static func markImage(_ m: Mark, width w: CGFloat) -> UIImage {
        let h = w * 0.42, f = UIGraphicsImageRendererFormat.default(); f.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: f).image { _ in
            let card = UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: w, height: h), cornerRadius: h * 0.18)
            UIColor(white: 0, alpha: 0.62).setFill(); card.fill()
            let center = NSMutableParagraphStyle(); center.alignment = .center
            let rounded = { (size: CGFloat, weight: UIFont.Weight) -> UIFont in
                let base = UIFont.systemFont(ofSize: size, weight: weight)
                return base.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? base
            }
            let t = NSAttributedString(string: m.title.uppercased(), attributes: [.font: rounded(h * 0.13, .bold), .foregroundColor: SprintOverlay.green, .kern: 1.2, .paragraphStyle: center])
            let b = NSAttributedString(string: m.big, attributes: [.font: rounded(h * 0.38, .heavy), .foregroundColor: UIColor.white, .paragraphStyle: center])
            let sm = NSAttributedString(string: m.small, attributes: [.font: rounded(h * 0.12, .semibold), .foregroundColor: UIColor(white: 1, alpha: 0.85), .paragraphStyle: center])
            t.draw(in: CGRect(x: 0, y: h * 0.07, width: w, height: h * 0.2))
            b.draw(in: CGRect(x: 0, y: h * 0.22, width: w, height: h * 0.5))
            sm.draw(in: CGRect(x: 0, y: h * 0.72, width: w, height: h * 0.2))
        }
    }

    /// The RSI numbers onto the clip, top centre, each while it applies.
    static func burnMarks(_ src: URL, marks: [Mark], fps: Double, done: @escaping (URL?) -> Void) {
        let asset = AVURLAsset(url: src)
        let cache = NSCache<NSNumber, CIImage>()
        let comp = AVMutableVideoComposition(asset: asset) { req in
            let img = req.sourceImage, t = req.compositionTime.seconds
            guard let k = marks.lastIndex(where: { t >= $0.from && t < $0.to }) else { req.finish(with: img, context: nil); return }
            let ext = img.extent, hud = marks[k].hud
            let w = hud != nil ? ext.width.rounded() : (min(ext.width, ext.height) * 0.62).rounded()
            var o = cache.object(forKey: NSNumber(value: k))
            if o == nil, let cg = (hud.map { hudImage($0, width: w) } ?? markImage(marks[k], width: w)).cgImage { o = CIImage(cgImage: cg); cache.setObject(o!, forKey: NSNumber(value: k)) }
            guard let ov = o else { req.finish(with: img, context: nil); return }
            let margin = min(ext.width, ext.height) * 0.08
            // the scoreboard sits low, over the floor, like a broadcast; the text card stays at the top
            let y = hud != nil ? ext.minY + margin : ext.maxY - margin - ov.extent.height
            let placed = ov.transformed(by: CGAffineTransform(translationX: ext.midX - ov.extent.width / 2, y: y))
            req.finish(with: placed.composited(over: img), context: nil)
        }
        comp.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, fps.rounded())))
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHEVCHighestQuality) else { done(nil); return }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("rsi-\(Int(Date().timeIntervalSince1970))-casy.mov")
        try? FileManager.default.removeItem(at: out)
        export.outputURL = out
        export.outputFileType = .mov
        export.videoComposition = comp
        export.metadata = [fullSpeed]
        export.exportAsynchronously { done(export.status == .completed ? out : nil) }
    }

    static func burn(_ src: URL, runs: [SprintRun], fps: Double, done: @escaping (URL?) -> Void) {
        let asset = AVURLAsset(url: src)
        let cache = NSCache<NSString, CIImage>()
        let comp = AVMutableVideoComposition(asset: asset) { req in
            let img = req.sourceImage
            guard let st = SprintOverlay.state(at: req.compositionTime.seconds, runs: runs) else {
                req.finish(with: img, context: nil); return
            }
            let ext = img.extent
            let d = (min(ext.width, ext.height) * 0.36).rounded()
            let key = "\(st.key)|\(d)" as NSString
            var overlay = cache.object(forKey: key)
            if overlay == nil, let cg = SprintOverlay.image(st, diameter: d, scale: 1).cgImage {
                overlay = CIImage(cgImage: cg)
                cache.setObject(overlay!, forKey: key)
            }
            guard let o = overlay else { req.finish(with: img, context: nil); return }
            // Bottom centre, as OVR Sprint has it; Core Image counts y from the bottom.
            let margin = min(ext.width, ext.height) * 0.06
            let placed = o.transformed(by: CGAffineTransform(translationX: ext.midX - o.extent.width / 2, y: ext.minY + margin))
            req.finish(with: placed.composited(over: img), context: nil)
        }
        comp.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, fps.rounded())))
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHEVCHighestQuality) else { done(nil); return }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("sprint-\(Int(Date().timeIntervalSince1970))-casy.mov")
        try? FileManager.default.removeItem(at: out)
        export.outputURL = out
        export.outputFileType = .mov
        export.videoComposition = comp
        export.metadata = [fullSpeed]
        export.exportAsynchronously { done(export.status == .completed ? out : nil) }
    }
}

// MARK: - RSI clips waiting for their numbers

/// Lives outside the recorder: the analysis can come back after the camera is closed.
final class RsiHold {
    static let shared = RsiHold()
    var notify: ((String, [String: Any]) -> Void)?
    private var pending: [String: (url: URL, fps: Double, timer: Timer?)] = [:]

    func hold(_ url: URL, fps: Double) -> String {
        let id = UUID().uuidString
        let timer = Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { [weak self] _ in self?.finalize(id: id, marks: [], late: true) }
        pending[id] = (url, fps, timer)
        return id
    }

    func finalize(id: String, marks: [SprintBurner.Mark], late: Bool = false) {
        DispatchQueue.main.async {
            guard let p = self.pending.removeValue(forKey: id) else { return }
            p.timer?.invalidate()
            let save = { (url: URL, burned: Bool) in
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                    guard status == .authorized || status == .limited else {
                        DispatchQueue.main.async { self.notify?("saved", ["message": "Skok nemá povolené ukladať do Fotiek. Zapni to v Nastavenia → Skok → Fotky.", "mode": "rsi"]) }
                        return
                    }
                    PHPhotoLibrary.shared().performChanges({ PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: nil) }) { ok, _ in
                        let msg = !ok ? "Do Fotiek sa video uložiť nepodarilo." : burned ? "RSI video uložené do Fotiek s časmi" : late ? "Rozbor neprišiel, video uložené bez časov" : "Video uložené do Fotiek"
                        DispatchQueue.main.async { self.notify?("saved", ["message": msg, "mode": "rsi", "burned": burned]) }
                    }
                }
            }
            guard !marks.isEmpty else { save(p.url, false); return }
            SprintBurner.burnMarks(p.url, marks: marks, fps: p.fps) { out in save(out ?? p.url, out != nil) }
        }
    }
}

// MARK: - The shutter, as on the iPhone

final class ShutterButton: UIControl {
    private let ring = UIView(), dot = UIView()
    var recording = false { didSet { update(animated: true) } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        ring.isUserInteractionEnabled = false
        dot.isUserInteractionEnabled = false
        ring.layer.borderColor = UIColor.white.cgColor
        ring.layer.borderWidth = 5
        dot.backgroundColor = UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
        addSubview(ring)
        addSubview(dot)
        accessibilityLabel = "Natáčať"
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        ring.frame = bounds
        ring.layer.cornerRadius = bounds.width / 2
        update(animated: false)
    }

    private func update(animated: Bool) {
        let s: CGFloat = recording ? bounds.width * 0.4 : bounds.width - 16
        let apply = {
            self.dot.bounds = CGRect(x: 0, y: 0, width: s, height: s)
            self.dot.center = CGPoint(x: self.bounds.midX, y: self.bounds.midY)
            self.dot.layer.cornerRadius = self.recording ? 7 : s / 2
        }
        if animated { UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseInOut, animations: apply) } else { apply() }
        accessibilityLabel = recording ? "Zastaviť" : "Natáčať"
    }

    override var isHighlighted: Bool { didSet { alpha = isHighlighted ? 0.75 : 1 } }
}

// MARK: - Freelap heard by the recorder itself

/// The recorder listens for the chips itself (Stanley, 2026-11-13: the ring closed only at the end
/// of the video). Runs passed on from the web page could arrive late while the camera covers it,
/// and the overlay is placed by the moment a run arrives, so that moment is taken here, where the
/// broadcast lands. Same frame layout as js/freelap/frame.js (vault: "Freelap FxChip BLE - format").
final class FreelapEar: NSObject, CBCentralManagerDelegate {
    struct Frame { let key: String; let chip: String; let lap: Double; let legs: [Double] }

    private var central: CBCentralManager?
    private var firstSeen: [String: CFTimeInterval] = [:]
    /// Every distinct frame of a run as hex, company ID left off (as the page keeps them): runs
    /// with two or more intermediates still read wrong, these let the layout be worked out.
    private(set) var raws: [String: [String]] = [:]
    var onFrame: ((Frame, CFTimeInterval) -> Void)?   // the frame and when its run was first heard

    func start() {
        central = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])
    }
    func stop() {
        if central?.state == .poweredOn { central?.stopScan() }
        central = nil
    }
    func seen(_ key: String) -> CFTimeInterval? { firstSeen[key] }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        guard c.state == .poweredOn else { return }
        c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData ad: [String: Any], rssi: NSNumber) {
        let now = CACurrentMediaTime()
        guard let data = ad[CBAdvertisementDataManufacturerDataKey] as? Data, let f = FreelapEar.frame(data) else { return }
        if firstSeen[f.key] == nil { firstSeen[f.key] = now }
        let hex = data.dropFirst(2).map { String(format: "%02x", $0) }.joined()
        var l = raws[f.key] ?? []
        if !l.contains(hex), l.count < 8 { l.append(hex); raws[f.key] = l }
        onFrame?(f, firstSeen[f.key] ?? now)
    }

    /// Manufacturer data as iOS gives it: company ID 0x0363 (63 03), then the chip frame.
    static func frame(_ data: Data) -> Frame? {
        let all = [UInt8](data)
        guard all.count >= 26, all[0] == 0x63, all[1] == 0x03 else { return nil }
        let b = Array(all[2...])
        guard b[0] == 0x58, (65...90).contains(b[2]), (65...90).contains(b[3]) else { return nil }
        func u32(_ i: Int) -> Int64 { Int64(b[i]) | Int64(b[i + 1]) << 8 | Int64(b[i + 2]) << 16 | Int64(b[i + 3]) << 24 }
        let id = Int(b[4]) | Int(b[5]) << 8
        let chip = String(UnicodeScalar(b[2])) + String(UnicodeScalar(b[3])) + "-" + String(format: "%04d", id)
        let mask: Int64 = 0x7fffffff
        let fromLap = u32(10), block = u32(14)
        // 3-byte crossings from byte 24 on the start's clock (js/freelap/frame.js): read as 4-byte
        // values they were right only with one intermediate (2026-11-15, 30 m runs).
        func u24(_ i: Int) -> Int64 { Int64(b[i]) | Int64(b[i + 1]) << 8 | Int64(b[i + 2]) << 16 }
        let start = fromLap & mask
        var laps: [Int64] = []
        var i = 24
        while i + 3 <= b.count, laps.count < 10 {
            let v = u24(i); if v == 0 { break }
            var full = start - (start % 0x1000000) + v
            if full < start { full += 0x1000000 }
            laps.append(full); i += 3
        }
        let sec: (Int64) -> Double = { (Double($0) / 10.24).rounded() / 100 }   // 1/1024 s ticks, to the hundredth
        // Intermediates only when each lies between the start and the finish, in order; some frames
        // carry other numbers there (2026-11-15: legs 1867777 + -1868514 + 740 = 3,58). Same rule
        // as js/freelap/frame.js.
        let from = fromLap & mask, fin = block & mask
        var real = true, p0 = from
        for v in laps { let m = v & mask; if m <= p0 || m >= fin { real = false; break }; p0 = m }
        // crossings rounded from the start, legs their differences: they add up to the lap
        let cum = (real ? laps : []).map { sec(($0 & mask) - from) } + [sec(fin - from)]
        var legs: [Double] = []
        for (i, c) in cum.enumerated() { legs.append(((c - (i > 0 ? cum[i - 1] : 0)) * 100).rounded() / 100) }
        let lap = sec((block & mask) - (fromLap & mask))
        guard lap > 0, lap < 600 else { return nil }
        return Frame(key: "\(chip):\(fromLap):\(block)", chip: chip, lap: lap, legs: legs)
    }
}

// MARK: - The recorder

final class RecorderViewController: UIViewController, AVCaptureFileOutputRecordingDelegate {
    var onEvent: ((String, [String: Any]) -> Void)?

    private let fps: Int
    private let mode: String              // "sprint" (Freelap ring) or "rsi" (saved after the analysis, with its numbers)
    private let freelapOn: Bool
    private let chips: [String: String]   // chip ID -> athlete name
    private let ear = FreelapEar()
    private var saving = 0                // videos still being written; filming goes on meanwhile
    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "sprint.camera")
    private var preview: AVCaptureVideoPreviewLayer!
    private var actualFps: Double = 0
    private var startedAt: CFTimeInterval?
    private var startedWall: Date?        // the same moment on the clock, for the page to pair the clip
    private var runs: [SprintRun] = []
    private var stoppedAt: CFTimeInterval?
    /// A clip just stopped with no run heard yet: its finish broadcast can land a moment after Stop
    /// (2026-11-15: some videos reached Photos without the times). Runs heard up to `grace` after
    /// Stop still go into it; the next sprint can be filmed meanwhile.
    private var late: (start: CFTimeInterval, stop: CFTimeInterval, runs: [SprintRun])?
    private let grace = 3.0
    private var ticker: Timer?
    private var held: UIDeviceOrientation = .portrait   // how the phone is held (the screen stays portrait)

    private let topBar = UIView(), bottomBar = UIView()
    private let shutter = ShutterButton()
    private let closeButton = UIButton(type: .system)
    private let timeLabel = UILabel()
    private let badge = UILabel()
    private let modeLabel = UILabel()
    private let freelapLabel = UILabel()
    private let toast = UILabel()
    private let overlayView = UIImageView()
    private let liveDiameter: CGFloat = 132
    private var reveal: CADisplayLink?
    private var revealStart: CFTimeInterval = 0
    private var liveKey = ""
    private var liveRun: (name: String, lap: Double, legs: [Double]) = ("", 0, [])

    init(fps: Int, freelapOn: Bool, chips: [String: String] = [:], mode: String = "sprint") {
        self.fps = fps
        self.mode = mode
        // Jumps and run-ups hear Freelap too (Stanley, 2026-11-20: "zapnúť tiež Freelap meranie"); RSI never.
        self.freelapOn = mode == "sprint" || mode == "jump" ? freelapOn : false
        self.chips = chips
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    // Like the Camera app: the screen stays upright and the controls turn with the phone.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspect   // the whole frame, as it is recorded
        view.layer.addSublayer(preview)
        buildUI()
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(self, selector: #selector(turned), name: UIDevice.orientationDidChangeNotification, object: nil)
        ear.onFrame = { [weak self] f, at in self?.note(key: f.key, name: self?.chips[f.chip] ?? f.chip, lap: f.lap, legs: f.legs, heard: at) }
        // Freelap off means off (Stanley, 2026-11-15): no listening, no times, no ring in the video.
        if freelapOn { ear.start() }
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                if ok { self.configure() } else { self.show("Skok nemá povolenú kameru. Zapni ju v Nastavenia → Skok → Kamera.", hold: true) }
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
        if let c = preview.connection, c.isVideoOrientationSupported { c.videoOrientation = .portrait }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        NotificationCenter.default.removeObserver(self)
        reveal?.invalidate(); reveal = nil
        if late == nil { ear.stop() }   // a run may still land in the 3 s after Stop
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
        queue.async { self.session.stopRunning() }
    }

    private func buildUI() {
        for v in [topBar, bottomBar] { v.backgroundColor = UIColor(white: 0, alpha: 0.55); v.translatesAutoresizingMaskIntoConstraints = false }

        shutter.translatesAutoresizingMaskIntoConstraints = false
        shutter.addTarget(self, action: #selector(toggleRecord), for: .touchUpInside)
        shutter.isEnabled = false

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .semibold)), for: .normal)
        closeButton.tintColor = .white
        closeButton.accessibilityLabel = "Zavrieť"
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)

        timeLabel.font = .monospacedDigitSystemFont(ofSize: 17, weight: .medium)
        timeLabel.textColor = .white
        timeLabel.textAlignment = .center
        timeLabel.text = "00:00:00"
        timeLabel.layer.cornerRadius = 6
        timeLabel.clipsToBounds = true

        badge.font = .systemFont(ofSize: 13, weight: .semibold)
        badge.textColor = .white
        badge.text = "HD · \(fps)"

        modeLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        modeLabel.textColor = UIColor(red: 1, green: 0.84, blue: 0.04, alpha: 1)
        modeLabel.attributedText = NSAttributedString(string: mode == "rsi" ? "RSI" : mode == "jump" ? "SKOK" : "ŠPRINT", attributes: [.kern: 1.5])

        freelapLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        freelapLabel.textColor = freelapOn ? SprintOverlay.green : UIColor(white: 1, alpha: 0.6)
        freelapLabel.text = mode == "rsi" ? "" : freelapOn ? "● Freelap" : "Freelap vypnutý"

        toast.font = .systemFont(ofSize: 15, weight: .semibold)
        toast.textColor = .white
        toast.backgroundColor = UIColor(white: 0, alpha: 0.65)
        toast.textAlignment = .center
        toast.numberOfLines = 0
        toast.layer.cornerRadius = 14
        toast.clipsToBounds = true
        toast.alpha = 0

        overlayView.contentMode = .center
        if freelapOn { showLive(.waiting()) }   // the ring is on screen the whole time with Freelap on
        for v in [timeLabel, badge, modeLabel, freelapLabel, toast, overlayView] { v.translatesAutoresizingMaskIntoConstraints = false }

        [overlayView, topBar, bottomBar, closeButton, timeLabel, badge, freelapLabel, modeLabel, shutter, toast].forEach(view.addSubview)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: view.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBar.bottomAnchor.constraint(equalTo: g.topAnchor, constant: 48),
            bottomBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomBar.topAnchor.constraint(equalTo: g.bottomAnchor, constant: -150),

            closeButton.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            closeButton.centerYAnchor.constraint(equalTo: topBar.bottomAnchor, constant: -24),
            closeButton.widthAnchor.constraint(equalToConstant: 44),
            closeButton.heightAnchor.constraint(equalToConstant: 44),
            timeLabel.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            timeLabel.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            timeLabel.widthAnchor.constraint(equalToConstant: 96),
            timeLabel.heightAnchor.constraint(equalToConstant: 28),
            badge.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            badge.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),

            shutter.widthAnchor.constraint(equalToConstant: 78),
            shutter.heightAnchor.constraint(equalToConstant: 78),
            shutter.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -22),
            modeLabel.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            modeLabel.bottomAnchor.constraint(equalTo: shutter.topAnchor, constant: -14),
            freelapLabel.centerYAnchor.constraint(equalTo: shutter.centerYAnchor),
            freelapLabel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 22),

            overlayView.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            overlayView.bottomAnchor.constraint(equalTo: bottomBar.topAnchor, constant: -16),
            toast.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            toast.centerYAnchor.constraint(equalTo: g.centerYAnchor),
            toast.widthAnchor.constraint(lessThanOrEqualTo: g.widthAnchor, constant: -48),
        ])
    }

    /// A short message in the middle, as the Camera app shows them.
    private func show(_ text: String, hold: Bool = false) {
        toast.text = "   \(text)   "
        toast.sizeToFit()
        UIView.animate(withDuration: 0.2) { self.toast.alpha = 1 }
        guard !hold else { return }
        let shown = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            if self.toast.text == "   \(shown)   " { UIView.animate(withDuration: 0.3) { self.toast.alpha = 0 } }
        }
    }

    @objc private func turned() {
        let o = UIDevice.current.orientation
        guard !output.isRecording, o == .portrait || o == .landscapeLeft || o == .landscapeRight else { return }
        held = o
        let angle: CGFloat = o == .landscapeLeft ? .pi / 2 : o == .landscapeRight ? -.pi / 2 : 0
        UIView.animate(withDuration: 0.25) {
            for v in [self.closeButton, self.badge, self.freelapLabel, self.overlayView, self.toast] as [UIView] {
                v.transform = CGAffineTransform(rotationAngle: angle)
            }
        }
    }

    /// The video's orientation follows how the phone is held when recording starts.
    private func recordingOrientation() -> AVCaptureVideoOrientation {
        switch held {
        case .landscapeLeft: return .landscapeRight
        case .landscapeRight: return .landscapeLeft
        default: return .portrait
        }
    }

    // The back wide camera at 1080p and the asked frame rate (or the best it reaches).
    private func configure() {
        queue.async {
            self.session.beginConfiguration()
            self.session.sessionPreset = .inputPriority
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: device), self.session.canAddInput(input),
                  self.session.canAddOutput(self.output) else {
                self.session.commitConfiguration()
                DispatchQueue.main.async { self.show("Kamera sa nedá otvoriť.", hold: true) }
                return
            }
            self.session.addInput(input)
            self.session.addOutput(self.output)
            self.output.metadata = [SprintBurner.fullSpeed]
            let fits: (AVCaptureDevice.Format, Double) -> Bool = { f, rate in
                let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
                return d.width == 1920 && d.height == 1080 && f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= rate }
            }
            var rate = Double(self.fps)
            var format = device.formats.first { fits($0, rate) }
            if format == nil { rate = 60; format = device.formats.first { fits($0, rate) } }
            if let f = format, (try? device.lockForConfiguration()) != nil {
                device.activeFormat = f
                let d = CMTime(value: 1, timescale: CMTimeScale(rate))
                device.activeVideoMinFrameDuration = d
                device.activeVideoMaxFrameDuration = d
                device.unlockForConfiguration()
                self.actualFps = rate
            } else {
                self.actualFps = 30
            }
            self.session.commitConfiguration()
            self.session.startRunning()
            DispatchQueue.main.async {
                self.shutter.isEnabled = true
                self.badge.text = "HD · \(Int(self.actualFps))"
            }
        }
    }

    @objc private func toggleRecord() {
        if output.isRecording { stop() } else { start() }
    }

    private func start() {
        guard actualFps > 0, !output.isRecording else { return }
        runs = []
        startedAt = nil
        reveal?.invalidate(); reveal = nil
        if freelapOn { showLive(.waiting()) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sprint-\(Int(Date().timeIntervalSince1970)).mov")
        let orientation = recordingOrientation()
        UIApplication.shared.isIdleTimerDisabled = true
        shutter.recording = true
        closeButton.isHidden = true
        queue.async {
            if let c = self.output.connection(with: .video), c.isVideoOrientationSupported { c.videoOrientation = orientation }
            self.output.startRecording(to: url, recordingDelegate: self)
        }
    }

    private func stop() {
        queue.async { self.output.stopRecording() }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        let now = CACurrentMediaTime()
        DispatchQueue.main.async {
            self.startedAt = now
            self.startedWall = Date()
            self.timeLabel.backgroundColor = UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
            self.ticker = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                guard let self, let s = self.startedAt else { return }
                let t = Int(CACurrentMediaTime() - s)
                self.timeLabel.text = String(format: "%02d:%02d:%02d", t / 3600, (t / 60) % 60, t % 60)
            }
        }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL, from connections: [AVCaptureConnection], error: Error?) {
        let stop = CACurrentMediaTime()
        DispatchQueue.main.async { self.stoppedAt = stop }
        let ok = error == nil || ((error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false)
        DispatchQueue.main.async {
            self.ticker?.invalidate()
            self.timeLabel.backgroundColor = .clear
            self.timeLabel.text = "00:00:00"
            self.shutter.recording = false
            if ok { self.finish(url) } else { self.saving += 1; self.done("Natáčanie sa nepodarilo.", burned: false) }
        }
    }

    // No waiting after Stop (Stanley: "čakám na časy je zbytočné a zdržuje, časy vždy dorazili"):
    // the runs heard so far go into the video, which is written in the background while the
    // next sprint can already be filmed.
    private func finish(_ url: URL) {
        let runs = self.runs, wall = startedWall
        // RSI (Stanley, 2026-11-14: "namiesto pôvodného"): nothing goes to Photos yet. The page
        // analyses the clip and sends its numbers back (finalize), and the clip is saved once, with
        // them burned in. No answer in 3 minutes: saved as filmed, so it is never lost.
        if mode == "rsi" {
            closeButton.isHidden = false
            UIApplication.shared.isIdleTimerDisabled = false
            let id = RsiHold.shared.hold(url, fps: actualFps)
            show("Rozoberám… video sa uloží s časmi")
            var data: [String: Any] = ["id": id, "raw": url.path, "fps": actualFps, "mode": "rsi"]
            if let wall { data["recordedAt"] = Int(wall.timeIntervalSince1970 * 1000) }
            onEvent?("recorded", data)
            autoClose()
            return
        }
        saving += 1
        closeButton.isHidden = false
        UIApplication.shared.isIdleTimerDisabled = false
        show(runs.isEmpty ? "Ukladám video…" : "Ukladám video s časmi…")
        // The page starts the upload now, from the clip as filmed (2026-11-15: waiting for the
        // ring to be burned in and the save to Photos cost 10-30 s per run); the times heard
        // follow with "saved".
        if mode == "sprint" {
            var data: [String: Any] = ["raw": url.path, "fps": actualFps, "mode": "sprint", "freelap": freelapOn]
            if let wall { data["recordedAt"] = Int(wall.timeIntervalSince1970 * 1000) }
            data["times"] = runs.map { ["key": $0.key, "name": $0.name, "lap": $0.lap, "legs": $0.legs, "arrived": $0.arrived, "raw": ear.raws[$0.key] ?? []] }
            onEvent?("recorded", data)
        }
        if runs.isEmpty, freelapOn, let s = startedAt {
            late = (s, stoppedAt ?? CACurrentMediaTime(), [])
            DispatchQueue.main.asyncAfter(deadline: .now() + grace) {
                let got = self.late?.runs ?? []
                self.late = nil
                if self.view.window == nil { self.ear.stop() }   // closed meanwhile
                self.write(url, runs: got, wall: wall)
            }
            autoClose()
            return
        }
        write(url, runs: runs, wall: wall)
        autoClose()
    }

    /// Stop closes the camera (Stanley, 2026-11-15: "keď stopnem nahrávanie nech sa to samé
    /// zavrie, nie že musím klikať na x"). The video is written and saved in the background, and
    /// the app opens it at once.
    private func autoClose() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, !self.output.isRecording, self.presentingViewController != nil else { return }
            self.close()
        }
    }

    private func write(_ url: URL, runs: [SprintRun], wall: Date?) {
        // A jump keeps its picture clean: the ring sits over the feet at the bottom of the frame, and a
        // jump saved to Photos may be uploaded again later. Its times go to the app with "saved".
        guard !runs.isEmpty, mode == "sprint" else { save(url, raw: url, wall: wall, runs: runs, burned: false); return }
        SprintBurner.burn(url, runs: runs, fps: actualFps) { out in
            DispatchQueue.main.async { self.save(out ?? url, raw: url, wall: wall, runs: runs, burned: out != nil) }
        }
    }

    // raw: the clip without the ring, kept in tmp for the page to analyse (the ring sits over the
    // feet at the bottom of the frame).
    private func save(_ url: URL, raw: URL, wall: Date?, runs: [SprintRun], burned: Bool) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { self.done("Skok nemá povolené ukladať do Fotiek. Zapni to v Nastavenia → Skok → Fotky.", runs: runs, burned: burned, path: url, raw: raw, wall: wall) }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: nil)
            }) { ok, _ in
                DispatchQueue.main.async {
                    let what = burned ? (runs.count == 1 ? "s časom" : "s časmi") : runs.isEmpty ? "bez časov" : "· čas z Freelapu v appke"
                    self.done(ok ? "Uložené do Fotiek \(what)" : "Do Fotiek sa video uložiť nepodarilo.", runs: runs, burned: burned, path: url, raw: raw, wall: wall)
                }
            }
        }
    }

    private func done(_ message: String, runs: [SprintRun] = [], burned: Bool, path: URL? = nil, raw: URL? = nil, wall: Date? = nil) {
        saving = max(0, saving - 1)
        show(message)
        var data: [String: Any] = ["message": message, "burned": burned, "runs": runs.count, "fps": actualFps, "mode": mode, "freelap": freelapOn]
        if let path { data["path"] = path.path }
        if let raw { data["raw"] = raw.path }
        if let wall { data["recordedAt"] = Int(wall.timeIntervalSince1970 * 1000) }
        // arrived: seconds into the clip when the run reached the phone (the chip crossing the last cone + latency)
        data["times"] = runs.map { ["key": $0.key, "name": $0.name, "lap": $0.lap, "legs": $0.legs, "arrived": $0.arrived, "raw": ear.raws[$0.key] ?? []] }
        onEvent?("saved", data)
    }

    /// A run from Freelap. It is noted against the recording when one is running (or just ended
    /// and the video isn't written yet), and always shown live.
    func takeRun(key: String, name: String, lap: Double, legs: [Double]) {
        note(key: key, name: name, lap: lap, legs: legs, heard: ear.seen(key) ?? CACurrentMediaTime())
    }

    /// One run, heard by the recorder itself or passed on by the page. heard: when the chip's
    /// broadcast of it first landed. The same run again only adds its intermediate.
    private func note(key: String, name: String, lap: Double, legs: [Double], heard: CFTimeInterval) {
        guard freelapOn else { return }
        if var l = late, !output.isRecording, heard >= l.start, heard <= l.stop + grace {
            if let i = l.runs.firstIndex(where: { $0.key == key }) {
                if legs.count > l.runs[i].legs.count { l.runs[i].legs = legs; l.runs[i].lap = lap }
            } else { l.runs.append(SprintRun(key: key, name: name, lap: lap, legs: legs, arrived: heard - l.start)) }
            late = l
        }
        if let i = runs.firstIndex(where: { $0.key == key }) {
            if legs.count <= runs[i].legs.count { return }
            runs[i].legs = legs
            runs[i].lap = lap
        } else if let s = startedAt, output.isRecording, heard >= s {
            runs.append(SprintRun(key: key, name: name, lap: lap, legs: legs, arrived: heard - s))
        } else if key == liveKey, legs.count <= liveRun.legs.count {
            return
        }
        // Freelap sends a run only after the finish, so live the ring can't run during the sprint:
        // when the time comes in, it fills in 0.6 s and closes green. The saved video has it in
        // step with the run.
        liveRun = (name, lap, legs)
        if key == liveKey, reveal == nil {   // the same run again, now with its intermediate
            showLive(.finished(name, lap: lap, legs: legs))
            return
        }
        liveKey = key
        reveal?.invalidate()
        revealStart = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(revealStep))
        link.add(to: .main, forMode: .common)
        reveal = link
    }

    @objc private func revealStep() {
        let p = min(1, (CACurrentMediaTime() - revealStart) / 0.6)
        let eased = 1 - pow(1 - p, 3)
        var st = SprintOverlay.State.finished(liveRun.name, lap: liveRun.lap, legs: liveRun.legs, progress: eased)
        if p >= 1 { st.flash = 0; reveal?.invalidate(); reveal = nil }
        showLive(st)
    }

    private func showLive(_ s: SprintOverlay.State) {
        overlayView.image = SprintOverlay.image(s, diameter: liveDiameter, scale: UIScreen.main.scale)
    }

    @objc private func close() {
        guard !output.isRecording else { return }
        if late == nil { ear.stop() }
        dismiss(animated: true) { self.onEvent?("closed", [:]) }
    }
}

/// Copies each picked video out of the picker's temporary file (it is deleted when the callback
/// returns) into the app's own temporary folder, in the order picked.
final class GalleryPickerDelegate: NSObject, PHPickerViewControllerDelegate {
    private let call: CAPPluginCall
    private let done: () -> Void
    init(call: CAPPluginCall, done: @escaping () -> Void) { self.call = call; self.done = done }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        if results.isEmpty { call.resolve(["files": []]); done(); return }
        let group = DispatchGroup(), lock = NSLock()
        var files = [[String: Any]?](repeating: nil, count: results.count)
        var failure: String?
        for (i, r) in results.enumerated() {
            let p = r.itemProvider
            let type = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .movie) == true } ?? UTType.movie.identifier
            group.enter()
            p.loadFileRepresentation(forTypeIdentifier: type) { url, err in
                defer { group.leave() }
                guard let url = url else { lock.lock(); failure = err?.localizedDescription ?? "Video sa nepodarilo načítať."; lock.unlock(); return }
                let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension
                let dst = FileManager.default.temporaryDirectory.appendingPathComponent("pick-\(UUID().uuidString).\(ext)")
                do {
                    try FileManager.default.copyItem(at: url, to: dst)
                    lock.lock(); files[i] = ["path": dst.path, "name": url.lastPathComponent]; lock.unlock()
                } catch { lock.lock(); failure = error.localizedDescription; lock.unlock() }
            }
        }
        group.notify(queue: .main) {
            let got = files.compactMap { $0 }
            if got.isEmpty, let f = failure { self.call.reject(f) } else { self.call.resolve(["files": got]) }
            self.done()
        }
    }
}



// MARK: - The copy for watching

enum ViewCopy {
    static func make(_ src: URL, to dst: URL, range: CMTimeRange? = nil, done: @escaping (String?) -> Void) {
        let q = DispatchQueue(label: "viewcopy", qos: .userInitiated)
        q.async {
            let asset = AVURLAsset(url: src)
            guard let vt = asset.tracks(withMediaType: .video).first else { done("Vo videu nie je obraz."); return }
            let at = asset.tracks(withMediaType: .audio).first
            guard let reader = try? AVAssetReader(asset: asset), let writer = try? AVAssetWriter(outputURL: dst, fileType: .mp4) else { done("Kópiu sa nepodarilo pripraviť."); return }
            let vOut = AVAssetReaderTrackOutput(track: vt, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
            vOut.alwaysCopiesSampleData = false
            guard reader.canAdd(vOut) else { done("Obraz sa nedá čítať."); return }
            reader.add(vOut)
            let size = vt.naturalSize, fps = Double(vt.nominalFrameRate > 0 ? vt.nominalFrameRate : 120)
            let rate = fps > 150 ? 36_000_000 : 24_000_000
            let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height),
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: rate,
                    AVVideoMaxKeyFrameIntervalKey: 4,
                    AVVideoAllowFrameReorderingKey: false,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                    AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()),
                ] as [String: Any],
            ])
            vIn.transform = vt.preferredTransform
            vIn.expectsMediaDataInRealTime = false
            guard writer.canAdd(vIn) else { done("Kópiu sa nedá zapísať."); return }
            writer.add(vIn)
            var aOut: AVAssetReaderTrackOutput? = nil, aIn: AVAssetWriterInput? = nil
            if let at = at {
                let o = AVAssetReaderTrackOutput(track: at, outputSettings: nil)
                let fmt = (at.formatDescriptions.first as! CMFormatDescription?)
                let i = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: fmt)
                i.expectsMediaDataInRealTime = false
                if reader.canAdd(o) && writer.canAdd(i) { reader.add(o); writer.add(i); aOut = o; aIn = i }
            }
            if let range = range { reader.timeRange = range }
            guard reader.startReading(), writer.startWriting() else { done(reader.error?.localizedDescription ?? writer.error?.localizedDescription ?? "Kópia zlyhala."); return }
            writer.startSession(atSourceTime: range?.start ?? .zero)
            let group = DispatchGroup()
            func pump(_ input: AVAssetWriterInput, _ output: AVAssetReaderTrackOutput, _ label: String) {
                group.enter()
                let qq = DispatchQueue(label: "viewcopy.\(label)")
                input.requestMediaDataWhenReady(on: qq) {
                    while input.isReadyForMoreMediaData {
                        if let sb = output.copyNextSampleBuffer() { if !input.append(sb) { reader.cancelReading(); input.markAsFinished(); group.leave(); return } }
                        else { input.markAsFinished(); group.leave(); return }
                    }
                }
            }
            pump(vIn, vOut, "v")
            if let aIn = aIn, let aOut = aOut { pump(aIn, aOut, "a") }
            group.notify(queue: q) {
                if reader.status == .failed { writer.cancelWriting(); done(reader.error?.localizedDescription ?? "Čítanie zlyhalo."); return }
                writer.finishWriting { done(writer.status == .completed ? nil : (writer.error?.localizedDescription ?? "Zápis zlyhal.")) }
            }
        }
    }
}


// MARK: - Where the jump is

/// The biggest motion in the clip, from the luma at 1/15 of the size: each frame against the one
/// two before, after the best shift of up to 3 samples (the hand's shake), smoothed over 0.1 s.
/// Checked on 8 RSI clips (2026-11-18): the peak is the rebound's flight or its landing.
enum JumpWindow {
    struct W { let from: Double; let to: Double; let dur: Double; let cut: Bool }
    static func find(_ src: URL) -> W? {
        let asset = AVURLAsset(url: src)
        guard let vt = asset.tracks(withMediaType: .video).first, let reader = try? AVAssetReader(asset: asset) else { return nil }
        let dur = CMTimeGetSeconds(asset.duration)
        if !(dur > 3.5) { return W(from: 0, to: dur, dur: dur, cut: false) }
        let out = AVAssetReaderTrackOutput(track: vt, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        out.alwaysCopiesSampleData = false
        guard reader.canAdd(out) else { return nil }
        reader.add(out)
        guard reader.startReading() else { return nil }
        let step = 15
        var frames: [[Float]] = [], times: [Double] = []
        var gw = 0, gh = 0
        while let sb = out.copyNextSampleBuffer() {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            CVPixelBufferLockBaseAddress(pb, .readOnly)
            let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0), row = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
            if let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0)?.assumingMemoryBound(to: UInt8.self) {
                gw = w / step; gh = h / step
                var g = [Float](repeating: 0, count: gw * gh)
                for y in 0..<gh { for x in 0..<gw {
                    let o = (y * step) * row + x * step
                    g[y * gw + x] = (Float(base[o]) + Float(base[o + 1]) + Float(base[o + row]) + Float(base[o + row + 1])) / 4
                } }
                frames.append(g); times.append(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)))
            }
            CVPixelBufferUnlockBaseAddress(pb, .readOnly)
        }
        let n = frames.count
        guard n > 10, gw > 10, gh > 10 else { return nil }
        var m = [Float](repeating: 0, count: n)
        for i in 2..<n {
            let a = frames[i - 2], b = frames[i]; var best = Float.greatestFiniteMagnitude
            for dy in -3...3 { for dx in -3...3 {
                var s: Float = 0, c: Float = 0
                for y in 4..<(gh - 4) { for x in 4..<(gw - 4) { s += abs(a[y * gw + x] - b[(y + dy) * gw + x + dx]); c += 1 } }
                best = min(best, s / c)
            } }
            m[i] = best
        }
        var pk = 0, top: Float = -1
        for i in 0..<n {
            var s: Float = 0, c: Float = 0
            for k in max(0, i - 6)...min(n - 1, i + 6) { s += m[k]; c += 1 }
            if s / c > top { top = s / c; pk = i }
        }
        let t = times[pk] - (times.first ?? 0)
        let from = max(0, t - 1.8), to = min(dur, t + 1.0)
        return W(from: from, to: to, dur: dur, cut: to - from < 0.8 * dur)
    }
}
