class Vibez < Formula
  desc "Team Radio — synchronized music listening for pair programming"
  homepage "https://github.com/yourorg/vibez"
  url "https://github.com/yourorg/vibez/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "PLACEHOLDER"
  license "MIT"

  depends_on "bun"

  def install
    system "bun", "install", "--production", "--frozen-lockfile"
    libexec.install "src", "public", "node_modules", "package.json"

    (bin/"vibez").write <<~SH
      #!/bin/bash
      exec "#{HOMEBREW_PREFIX}/bin/bun" run "#{libexec}/src/index.ts" "$@"
    SH

    # Install default env config
    (etc/"vibez").mkpath
    (etc/"vibez/env").write <<~ENV unless (etc/"vibez/env").exist?
      # Slack Bot Token (xoxb-...)
      SLACK_BOT_TOKEN=

      # Slack App-Level Token for Socket Mode (xapp-...)
      SLACK_APP_TOKEN=

      # Public URL where the radio web player is hosted
      RADIO_URL=http://localhost:3000

      # Server port
      PORT=3000
    ENV
  end

  service do
    run [opt_bin/"vibez"]
    environment_variables PATH: "#{HOMEBREW_PREFIX}/bin:#{HOMEBREW_PREFIX}/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
    keep_alive true
    working_dir var/"vibez"
    log_path var/"log/vibez.log"
    error_log_path var/"log/vibez.log"
  end

  def caveats
    <<~EOS
      To configure vibez, edit the environment file:
        #{etc}/vibez/env

      Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN for Slack integration.

      Start the service:
        brew services start vibez

      Then open http://localhost:3000 in your browser.
    EOS
  end

  test do
    assert_match "vibez", shell_output("#{bin}/vibez --help 2>&1", 1)
  end
end
