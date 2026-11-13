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
    ]
    private weak var recorder: RecorderViewController?

    /// Opens the recorder over the app. freelap: whether the chips are being listened to.
    @objc func open(_ call: CAPPluginCall) {
        let fps = call.getInt("fps") ?? 120
        let freelapOn = call.getBool("freelap") ?? false
        let chips = (call.getObject("chips") ?? [:]).compactMapValues { $0 as? String }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("No view"); return }
            let vc = RecorderViewController(fps: fps, freelapOn: freelapOn, chips: chips)
            vc.onEvent = { [weak self] name, data in self?.notifyListeners(name, data: data) }
            vc.modalPresentationStyle = .overFullScreen   // keeps the web page in the window, so it keeps running
            host.present(vc, animated: true)
            self.recorder = vc
            call.resolve()
        }
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
        var laps: [Int64] = []
        var i = 24
        while i + 4 <= b.count, laps.count < 10 { let v = u32(i); if v == 0 { break }; laps.append(v); i += 4 }
        let sec: (Int64) -> Double = { (Double($0) / 10.24).rounded() / 100 }   // 1/1024 s ticks, to the hundredth
        var legs: [Double] = [], prev = fromLap & mask
        for v in laps { legs.append(sec(v - prev)); prev = v }
        legs.append(sec((block & mask) - prev))
        let lap = sec((block & mask) - (fromLap & mask))
        guard lap > 0, lap < 600 else { return nil }
        return Frame(key: "\(chip):\(fromLap):\(block)", chip: chip, lap: lap, legs: legs)
    }
}

// MARK: - The recorder

final class RecorderViewController: UIViewController, AVCaptureFileOutputRecordingDelegate {
    var onEvent: ((String, [String: Any]) -> Void)?

    private let fps: Int
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
    private var runs: [SprintRun] = []
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

    init(fps: Int, freelapOn: Bool, chips: [String: String] = [:]) {
        self.fps = fps
        self.freelapOn = freelapOn
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
        ear.start()
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
        ear.stop()
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
        modeLabel.attributedText = NSAttributedString(string: "ŠPRINT", attributes: [.kern: 1.5])

        freelapLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        freelapLabel.textColor = freelapOn ? SprintOverlay.green : UIColor(white: 1, alpha: 0.6)
        freelapLabel.text = freelapOn ? "● Freelap" : "Freelap vypnutý"

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
            self.timeLabel.backgroundColor = UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
            self.ticker = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                guard let self, let s = self.startedAt else { return }
                let t = Int(CACurrentMediaTime() - s)
                self.timeLabel.text = String(format: "%02d:%02d:%02d", t / 3600, (t / 60) % 60, t % 60)
            }
        }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL, from connections: [AVCaptureConnection], error: Error?) {
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
        let runs = self.runs
        saving += 1
        closeButton.isHidden = false
        UIApplication.shared.isIdleTimerDisabled = false
        show(runs.isEmpty ? "Ukladám video…" : "Ukladám video s časmi…")
        guard !runs.isEmpty else { save(url, runs: runs, burned: false); return }
        SprintBurner.burn(url, runs: runs, fps: actualFps) { out in
            DispatchQueue.main.async { self.save(out ?? url, runs: runs, burned: out != nil) }
        }
    }

    private func save(_ url: URL, runs: [SprintRun], burned: Bool) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { self.done("Skok nemá povolené ukladať do Fotiek. Zapni to v Nastavenia → Skok → Fotky.", runs: runs, burned: burned, path: url) }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: nil)
            }) { ok, _ in
                DispatchQueue.main.async {
                    let what = burned ? (runs.count == 1 ? "s časom" : "s časmi") : "bez časov"
                    self.done(ok ? "Uložené do Fotiek \(what)" : "Do Fotiek sa video uložiť nepodarilo.", runs: runs, burned: burned, path: url)
                }
            }
        }
    }

    private func done(_ message: String, runs: [SprintRun] = [], burned: Bool, path: URL? = nil) {
        saving = max(0, saving - 1)
        show(message)
        var data: [String: Any] = ["message": message, "burned": burned, "runs": runs.count, "fps": actualFps]
        if let path { data["path"] = path.path }
        data["times"] = runs.map { ["name": $0.name, "lap": $0.lap, "legs": $0.legs] }
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
        ear.stop()
        dismiss(animated: true) { self.onEvent?("closed", [:]) }
    }
}
