// Filming sprints inside the app, with the Freelap times on the video (Stanley, 2026-11-13: "sprint
// tab, keď natáčaš a je zapnutý Freelap, nech sa to pridá priamo do videa ako overlay, časy v rohu").
//
// The recorder films at 120 fps. While it films, the web page passes every Freelap run it hears
// (SprintCamera.run) and the recorder notes when it arrived. A chip broadcasts its run right after
// the finish, so the finish moment is "arrival minus a short radio delay", and the start is the
// finish minus the lap time. After Stop the video is written again with the overlay burned in: a
// clock running from the start crossing, each leg as it is passed, and the final time held, the way
// photocell apps show it. The overlay in the saved video is placed by that estimate, so it can be a
// frame or two off; the times themselves are Freelap's own.
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

    /// The box: the athlete, the clock, then each leg. u is the size unit (about the name's height).
    static func image(_ s: State, unit u: CGFloat, scale: CGFloat) -> UIImage {
        let green = UIColor(red: 0.24, green: 0.86, blue: 0.59, alpha: 1)
        let nameFont = UIFont.systemFont(ofSize: u * 0.8, weight: .heavy)
        let clockFont = UIFont.monospacedDigitSystemFont(ofSize: u * 2.1, weight: .bold)
        let unitFont = UIFont.systemFont(ofSize: u * 0.9, weight: .semibold)
        let legFont = UIFont.monospacedDigitSystemFont(ofSize: u * 0.85, weight: .semibold)

        let name = NSAttributedString(string: s.name.uppercased(), attributes: [.font: nameFont, .foregroundColor: green, .kern: u * 0.06])
        let clock = NSMutableAttributedString(string: sec(s.clock), attributes: [.font: clockFont, .foregroundColor: s.final ? green : UIColor.white])
        clock.append(NSAttributedString(string: " s", attributes: [.font: unitFont, .foregroundColor: UIColor(white: 1, alpha: 0.7)]))
        let legs: [NSAttributedString] = s.legs.enumerated().map { i, l in
            let line = NSMutableAttributedString(string: "Úsek \(i + 1)  ", attributes: [.font: legFont, .foregroundColor: UIColor(white: 1, alpha: 0.6)])
            line.append(NSAttributedString(string: sec(l), attributes: [.font: legFont, .foregroundColor: UIColor.white]))
            return line
        }

        let pad = u * 0.7, gap = u * 0.25
        let lines = [name, clock] + legs
        let sizes = lines.map { $0.size() }
        // The width doesn't jump while the clock runs: sized for a two-digit time.
        let widest = max(sizes.map(\.width).max() ?? 0, NSAttributedString(string: "00,00", attributes: [.font: clockFont]).size().width + u * 1.4)
        let height = sizes.map(\.height).reduce(0, +) + gap * CGFloat(lines.count - 1) + pad * 2
        let size = CGSize(width: ceil(widest + pad * 2 + u * 0.3), height: ceil(height))

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            let box = UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: u * 0.45)
            UIColor(white: 0, alpha: 0.62).setFill()
            box.fill()
            (s.final ? green : UIColor(white: 1, alpha: 0.35)).setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: u * 0.3, height: size.height), byRoundingCorners: [.topLeft, .bottomLeft], cornerRadii: CGSize(width: u * 0.45, height: u * 0.45)).fill()
            var y = pad
            for (line, sz) in zip(lines, sizes) {
                line.draw(at: CGPoint(x: pad + u * 0.3, y: y))
                y += sz.height + gap
            }
        }
    }
}

// MARK: - Writing the video again with the overlay

enum SprintBurner {
    static func burn(_ src: URL, runs: [SprintRun], fps: Double, done: @escaping (URL?) -> Void) {
        let asset = AVURLAsset(url: src)
        let cache = NSCache<NSString, CIImage>()
        let comp = AVMutableVideoComposition(asset: asset) { req in
            let img = req.sourceImage
            guard let st = SprintOverlay.state(at: req.compositionTime.seconds, runs: runs) else {
                req.finish(with: img, context: nil); return
            }
            let ext = img.extent
            let u = (min(ext.width, ext.height) * 0.04).rounded()
            let key = "\(st.key)|\(u)" as NSString
            var overlay = cache.object(forKey: key)
            if overlay == nil, let cg = SprintOverlay.image(st, unit: u, scale: 1).cgImage {
                overlay = CIImage(cgImage: cg)
                cache.setObject(overlay!, forKey: key)
            }
            guard let o = overlay else { req.finish(with: img, context: nil); return }
            let margin = u * 1.2   // top-left corner; Core Image counts y from the bottom
            let placed = o.transformed(by: CGAffineTransform(translationX: ext.minX + margin, y: ext.maxY - margin - o.extent.height))
            req.finish(with: placed.composited(over: img), context: nil)
        }
        comp.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, fps.rounded())))
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHEVCHighestQuality) else { done(nil); return }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("sprint-freelap-\(Int(Date().timeIntervalSince1970)).mov")
        try? FileManager.default.removeItem(at: out)
        export.outputURL = out
        export.outputFileType = .mov
        export.videoComposition = comp
        export.exportAsynchronously { done(export.status == .completed ? out : nil) }
    }
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
    private var busy = false            // saving: no new recording, no closing
    private var ticker: Timer?

    private let recordButton = UIButton(type: .custom)
    private let closeButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let timeLabel = UILabel()
    private let overlayView = UIImageView()

    init(fps: Int, freelapOn: Bool) {
        self.fps = fps
        self.freelapOn = freelapOn
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { output.isRecording || busy ? currentMask : .allButUpsideDown }
    override var prefersStatusBarHidden: Bool { true }
    private var currentMask: UIInterfaceOrientationMask {
        switch view.window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .portrait
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspect   // the whole frame, as it is recorded
        view.layer.addSublayer(preview)
        buildUI()
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                if ok { self.configure() } else { self.say("Skok nemá povolenú kameru. Zapni ju v Nastavenia → Skok → Kamera.") }
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
        if let c = preview.connection, c.isVideoOrientationSupported { c.videoOrientation = videoOrientation() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        queue.async { self.session.stopRunning() }
    }

    private func buildUI() {
        recordButton.translatesAutoresizingMaskIntoConstraints = false
        recordButton.layer.cornerRadius = 38
        recordButton.layer.borderWidth = 5
        recordButton.layer.borderColor = UIColor.white.cgColor
        recordButton.backgroundColor = UIColor(red: 0.9, green: 0.15, blue: 0.15, alpha: 1)
        recordButton.accessibilityLabel = "Natáčať"
        recordButton.addTarget(self, action: #selector(toggleRecord), for: .touchUpInside)
        recordButton.isEnabled = false

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("Zavrieť", for: .normal)
        closeButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor(white: 0, alpha: 0.45)
        closeButton.layer.cornerRadius = 18
        closeButton.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)

        for l in [statusLabel, timeLabel] {
            l.translatesAutoresizingMaskIntoConstraints = false
            l.textColor = .white
            l.numberOfLines = 0
            l.textAlignment = .center
            l.backgroundColor = UIColor(white: 0, alpha: 0.45)
            l.layer.cornerRadius = 10
            l.clipsToBounds = true
        }
        statusLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 17, weight: .bold)
        timeLabel.isHidden = true
        overlayView.translatesAutoresizingMaskIntoConstraints = false
        overlayView.contentMode = .topLeft

        [overlayView, statusLabel, timeLabel, closeButton, recordButton].forEach(view.addSubview)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            recordButton.widthAnchor.constraint(equalToConstant: 76),
            recordButton.heightAnchor.constraint(equalToConstant: 76),
            recordButton.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            recordButton.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
            closeButton.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            closeButton.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            overlayView.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            overlayView.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            timeLabel.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            timeLabel.topAnchor.constraint(equalTo: g.topAnchor, constant: 12),
            timeLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 90),
            timeLabel.heightAnchor.constraint(equalToConstant: 32),
            statusLabel.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            statusLabel.bottomAnchor.constraint(equalTo: recordButton.topAnchor, constant: -14),
            statusLabel.widthAnchor.constraint(lessThanOrEqualTo: g.widthAnchor, constant: -32),
        ])
        say(freelapOn ? "Freelap počúva: časy sa pridajú do videa." : "Freelap je vypnutý: video bude bez časov.")
    }

    private func say(_ text: String) { statusLabel.text = "  \(text)  " }

    // The back wide camera at 1080p and the asked frame rate (or the best it reaches).
    private func configure() {
        queue.async {
            self.session.beginConfiguration()
            self.session.sessionPreset = .inputPriority
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: device), self.session.canAddInput(input),
                  self.session.canAddOutput(self.output) else {
                self.session.commitConfiguration()
                DispatchQueue.main.async { self.say("Kamera sa nedá otvoriť.") }
                return
            }
            self.session.addInput(input)
            self.session.addOutput(self.output)
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
                self.recordButton.isEnabled = true
                self.say("\(Int(self.actualFps)) fps · " + (self.freelapOn ? "Freelap počúva: časy sa pridajú do videa." : "Freelap je vypnutý: video bude bez časov."))
            }
        }
    }

    private func videoOrientation() -> AVCaptureVideoOrientation {
        switch view.window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .portrait
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
        let orientation = videoOrientation()
        UIApplication.shared.isIdleTimerDisabled = true
        recordButton.layer.cornerRadius = 14
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
            self.timeLabel.isHidden = false
            self.ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                guard let self, let s = self.startedAt else { return }
                self.timeLabel.text = "  ● \(SprintOverlay.sec(CACurrentMediaTime() - s))  "
            }
        }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL, from connections: [AVCaptureConnection], error: Error?) {
        let ok = error == nil || ((error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false)
        DispatchQueue.main.async {
            self.ticker?.invalidate()
            self.timeLabel.isHidden = true
            self.recordButton.layer.cornerRadius = 38
            if ok { self.finish(url) } else { self.done("Natáčanie sa nepodarilo.", nil, burned: false) }
        }
    }

    // A run that ends just before Stop reaches the phone a moment later, so with Freelap on the
    // recorder waits briefly before writing the video.
    private func finish(_ url: URL) {
        busy = true
        recordButton.isEnabled = false
        say(freelapOn ? "Čakám na čas z Freelapu…" : "Ukladám…")
        DispatchQueue.main.asyncAfter(deadline: .now() + (freelapOn ? 2.5 : 0)) {
            let runs = self.runs
            if runs.isEmpty { self.save(url, burned: false); return }
            self.say("Pridávam časy do videa…")
            SprintBurner.burn(url, runs: runs, fps: self.actualFps) { out in
                DispatchQueue.main.async { self.save(out ?? url, burned: out != nil) }
            }
        }
    }

    private func save(_ url: URL, burned: Bool) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { self.done("Skok nemá povolené ukladať do Fotiek. Zapni to v Nastavenia → Skok → Fotky.", url, burned: burned) }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: nil)
            }) { ok, _ in
                DispatchQueue.main.async {
                    let n = self.runs.count
                    let what = burned ? "s \(n == 1 ? "časom" : "časmi") z Freelapu" : "bez časov"
                    self.done(ok ? "Uložené do Fotiek (\(what))." : "Do Fotiek sa video uložiť nepodarilo.", url, burned: burned)
                }
            }
        }
    }

    private func done(_ message: String, _ url: URL?, burned: Bool) {
        busy = false
        recordButton.isEnabled = true
        closeButton.isHidden = false
        UIApplication.shared.isIdleTimerDisabled = false
        say(message)
        var data: [String: Any] = ["message": message, "burned": burned, "runs": runs.count, "fps": actualFps]
        if let url { data["path"] = url.path }
        data["times"] = runs.map { ["name": $0.name, "lap": $0.lap, "legs": $0.legs] }
        onEvent?("saved", data)
    }

    /// A run from Freelap. It is noted against the recording when one is running (or just ended
    /// and the video isn't written yet), and always shown live.
    func takeRun(key: String, name: String, lap: Double, legs: [Double]) {
        if let s = startedAt {
            if let i = runs.firstIndex(where: { $0.key == key }) {
                runs[i].lap = lap; runs[i].legs = legs
            } else {
                runs.append(SprintRun(key: key, name: name, lap: lap, legs: legs, arrived: CACurrentMediaTime() - s))
            }
        }
        let state = SprintOverlay.State(name: name, clock: lap, legs: legs.count > 1 ? legs : [], final: true)
        overlayView.image = SprintOverlay.image(state, unit: 16, scale: UIScreen.main.scale)
    }

    @objc private func close() {
        guard !output.isRecording, !busy else { return }
        dismiss(animated: true) { self.onEvent?("closed", [:]) }
    }
}
