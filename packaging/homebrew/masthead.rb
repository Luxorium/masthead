# Outline for a Homebrew tap formula. Not published. Fill url/sha256 from the released npm tarball.
class Masthead < Formula
  desc "Local web app that runs a tiered team of AI agents through your own Claude Code"
  homepage "https://github.com/Luxorium/masthead"
  url "https://registry.npmjs.org/@luxorium/masthead/-/masthead-0.2.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    # --os=none --cpu=none (npm ignores --omit=optional for a global install): skip the Agent SDK's private Claude Code binary; Masthead runs the user's own.
    system "npm", "install", *std_npm_args, "--os=none", "--cpu=none"
    bin.install_symlink libexec.glob("bin/*")
  end

  service do
    run [opt_bin/"masthead", "serve"]
    keep_alive successful_exit: false
    log_path var/"log/masthead.log"
    error_log_path var/"log/masthead.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/masthead --version")
  end
end
