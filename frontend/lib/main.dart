import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'VP9 MPEG-DASH Player',
      home: DashPlayerScreen(),
    );
  }
}

class DashPlayerScreen extends StatefulWidget {
  const DashPlayerScreen({super.key});
  @override
  State<DashPlayerScreen> createState() => _DashPlayerScreenState();
}

class _DashPlayerScreenState extends State<DashPlayerScreen> {
  VideoPlayerController? _controller;

  // 🔗 Replace this with your actual DASH manifest URL
  final String manifestUrl = "http://192.168.1.47:3000/dash/123/output.mpd";

  @override
  void initState() {
    super.initState();
    _initializePlayer();
  }

  Future<void> _initializePlayer() async {
    // The video_player plugin doesn’t natively handle .mpd manifests.
    // But browsers (on Web) and platforms that support DASH+VP9 natively can.
    // So we use the `VideoPlayerController.networkUrl` API directly.
    final uri = Uri.parse(manifestUrl);

    _controller = VideoPlayerController.networkUrl(
      uri,
      videoPlayerOptions: VideoPlayerOptions(mixWithOthers: false),
      formatHint: VideoFormat.dash,
    );

    await _controller!.initialize();
    _controller!.setLooping(true);
    _controller!.play();
    setState(() {});
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('VP9 DASH Player')),
      body: Center(
        child: _controller != null && _controller!.value.isInitialized
            ? AspectRatio(
                aspectRatio: _controller!.value.aspectRatio,
                child: VideoPlayer(_controller!),
              )
            : const CircularProgressIndicator(),
      ),
      floatingActionButton: _controller == null
          ? null
          : FloatingActionButton(
              onPressed: () {
                setState(() {
                  _controller!.value.isPlaying
                      ? _controller!.pause()
                      : _controller!.play();
                });
              },
              child: Icon(
                _controller!.value.isPlaying ? Icons.pause : Icons.play_arrow,
              ),
            ),
    );
  }
}
