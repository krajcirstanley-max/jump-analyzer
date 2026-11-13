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
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("No view"); return }
            let vc = RecorderViewController(fps: fps, freelapOn: freelapOn)
            vc.onEvent = { [weak self] name, data in self?.notifyListeners(name, data: data) }
            vc.modalPresentationStyle = .fullScreen
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

    struct State: Equatable {
        var name: String
        var clock: Double      // seconds, to the hundredth
        var legs: [Double]     // the legs passed so far (all of them once finished)
        var final: Bool
        var key: String { "\(name)|\(clock)|\(legs)|\(final)" }
    }

    static func sec(_ x: Double) -> String { String(format: "%.2f", x).replacingOccurrences(of: ".", with: ",") }

    /// What the overlay shows at video time t. Each run shows from its start until the next run
    /// starts; nothing shows before the first one.
    static func state(at t: Double, runs: [SprintRun]) -> State? {
        var shown: State?
        for r in runs.sorted(by: { $0.arrived < $1.arrived }) {
            let finish = r.arrived - latency, start = finish - r.lap
            if t < start { continue }
            if t < finish {
                let el = floor((t - start) * 100) / 100
                var acc = 0.0, done: [Double] = []
                for l in r.legs.dropLast() { acc += l; if el >= acc { done.append(l) } }
                shown = State(name: r.name, clock: el, legs: done, final: false)
            } else {
                shown = State(name: r.name, clock: r.lap, legs: r.legs.count > 1 ? r.legs : [], final: true)
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

    /// The ring timer, as OVR Sprint draws it: a dark disc, a ring that goes round once a second
    /// while the clock runs and closes in green at the finish, the time in the middle, the athlete
    /// above it, and the legs as pills under the disc. d is the disc's diameter.
    static func image(_ s: State, diameter d: CGFloat, scale: CGFloat) -> UIImage {
        let line = d * 0.075
        let timeFont = rounded(d * 0.25, .bold)
        let nameFont = rounded(d * 0.085, .heavy)
        let unitFont = rounded(d * 0.09, .semibold)
        let pillFont = rounded(d * 0.1, .bold)
        let labelFont = rounded(d * 0.075, .semibold)

        let pills: [NSAttributedString] = s.legs.enumerated().map { i, l in
            let t = NSMutableAttributedString(string: "\(i + 1).  ", attributes: [.font: labelFont, .foregroundColor: UIColor(white: 1, alpha: 0.6)])
            t.append(NSAttributedString(string: sec(l), attributes: [.font: pillFont, .foregroundColor: UIColor.white]))
            return t
        }
        let pillPadX = d * 0.07, pillH = d * 0.17, pillGap = d * 0.04
        let pillWidths = pills.map { $0.size().width + pillPadX * 2 }
        let pillsWidth = pillWidths.reduce(0, +) + pillGap * CGFloat(max(0, pills.count - 1))
        let width = max(d, pillsWidth)
        let height = d + (pills.isEmpty ? 0 : d * 0.06 + pillH)

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: ceil(width), height: ceil(height)), format: format).image { ctx in
            let c = CGPoint(x: width / 2, y: d / 2), r = d / 2 - line / 2
            UIColor(white: 0, alpha: 0.5).setFill()
            UIBezierPath(ovalIn: CGRect(x: c.x - d / 2, y: 0, width: d, height: d)).fill()
            let track = UIBezierPath(arcCenter: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: true)
            track.lineWidth = line
            UIColor(white: 1, alpha: 0.22).setStroke()
            track.stroke()
            let frac = s.final ? 1 : max(0.002, s.clock.truncatingRemainder(dividingBy: 1))
            let arc = UIBezierPath(arcCenter: c, radius: r, startAngle: -.pi / 2, endAngle: -.pi / 2 + .pi * 2 * CGFloat(frac), clockwise: true)
            arc.lineWidth = line
            arc.lineCapStyle = .round
            (s.final ? green : blue).setStroke()
            arc.stroke()

            let name = NSAttributedString(string: s.name.uppercased(), attributes: [.font: nameFont, .foregroundColor: s.final ? green : blue, .kern: d * 0.01])
            let time = NSAttributedString(string: sec(s.clock), attributes: [.font: timeFont, .foregroundColor: UIColor.white])
            let unit = NSAttributedString(string: "s", attributes: [.font: unitFont, .foregroundColor: UIColor(white: 1, alpha: 0.7)])
            let ts = time.size(), ns = name.size(), us = unit.size()
            time.draw(at: CGPoint(x: c.x - ts.width / 2, y: c.y - ts.height / 2))
            name.draw(at: CGPoint(x: c.x - ns.width / 2, y: c.y - ts.height / 2 - ns.height * 0.95))
            unit.draw(at: CGPoint(x: c.x - us.width / 2, y: c.y + ts.height / 2 - us.height * 0.15))

            var x = (width - pillsWidth) / 2
            let y = d + d * 0.06
            for (p, w) in zip(pills, pillWidths) {
                UIColor(white: 0, alpha: 0.55).setFill()
                UIBezierPath(roundedRect: CGRect(x: x, y: y, width: w, height: pillH), cornerRadius: pillH / 2).fill()
                let ps = p.size()
                p.draw(at: CGPoint(x: x + (w - ps.width) / 2, y: y + (pillH - ps.height) / 2))
                x += w + pillGap
            }
            _ = ctx
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

// MARK: - The recorder

final class RecorderViewController: UIViewController, AVCaptureFileOutputRecordingDelegate {
    var onEvent: ((String, [String: Any]) -> Void)?

    private let fps: Int
    private let freelapOn: Bool
    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "sprint.camera")
    private var preview: AVCaptureVideoPreviewLayer!
    private var actualFps: Double = 0
    private var startedAt: CFTimeInterval?
    private var runs: [SprintRun] = []
    private var busy = false            // writing the video: no new recording, no closing
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

    init(fps: Int, freelapOn: Bool) {
        self.fps = fps
        self.freelapOn = freelapOn
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
        guard !output.isRecording, !busy, o == .portrait || o == .landscapeLeft || o == .landscapeRight else { return }
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
        guard !busy, actualFps > 0 else { return }
        runs = []
        startedAt = nil
        overlayView.image = nil
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
            if ok { self.finish(url) } else { self.done("Natáčanie sa nepodarilo.", burned: false) }
        }
    }

    // A run that ends just before Stop reaches the phone a moment later, so with Freelap on the
    // recorder waits briefly before writing the video.
    private func finish(_ url: URL) {
        busy = true
        shutter.isEnabled = false
        show(freelapOn ? "Čakám na čas z Freelapu…" : "Ukladám…", hold: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + (freelapOn ? 2.5 : 0)) {
            let runs = self.runs
            self.show(runs.isEmpty ? "Ukladám…" : "Pridávam časy do videa…", hold: true)
            guard !runs.isEmpty else { self.save(url, burned: false); return }
            SprintBurner.burn(url, runs: runs, fps: self.actualFps) { out in
                DispatchQueue.main.async { self.save(out ?? url, burned: out != nil) }
            }
        }
    }

    private func save(_ url: URL, burned: Bool) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { self.done("Skok nemá povolené ukladať do Fotiek. Zapni to v Nastavenia → Skok → Fotky.", burned: burned, path: url) }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: nil)
            }) { ok, _ in
                DispatchQueue.main.async {
                    let n = self.runs.count
                    let what = burned ? (n == 1 ? "s časom" : "s časmi") : "bez časov"
                    self.done(ok ? "Uložené do Fotiek \(what)" : "Do Fotiek sa video uložiť nepodarilo.", burned: burned, path: url)
                }
            }
        }
    }

    private func done(_ message: String, burned: Bool, path: URL? = nil) {
        busy = false
        shutter.isEnabled = true
        closeButton.isHidden = false
        UIApplication.shared.isIdleTimerDisabled = false
        show(message)
        var data: [String: Any] = ["message": message, "burned": burned, "runs": runs.count, "fps": actualFps]
        if let path { data["path"] = path.path }
        data["times"] = runs.map { ["name": $0.name, "lap": $0.lap, "legs": $0.legs] }
        onEvent?("saved", data)
    }

    /// A run from Freelap. It is noted against the recording when one is running (or just ended
    /// and the video isn't written yet), and always shown live.
    func takeRun(key: String, name: String, lap: Double, legs: [Double]) {
        if let s = startedAt, output.isRecording || busy {
            if let i = runs.firstIndex(where: { $0.key == key }) {
                runs[i].lap = lap; runs[i].legs = legs
            } else {
                runs.append(SprintRun(key: key, name: name, lap: lap, legs: legs, arrived: CACurrentMediaTime() - s))
            }
        }
        let state = SprintOverlay.State(name: name, clock: lap, legs: legs.count > 1 ? legs : [], final: true)
        overlayView.image = SprintOverlay.image(state, diameter: 128, scale: UIScreen.main.scale)
    }

    @objc private func close() {
        guard !output.isRecording, !busy else { return }
        dismiss(animated: true) { self.onEvent?("closed", [:]) }
    }
}
