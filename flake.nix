{
  description = "mini-volition: A local ACP-based fleet runtime";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;
        runtimeBins = [
          "fleet"
          "agent-mail"
          "agent-runtime"
          "operator-console"
          "agent-state"
          "agent-jobs"
          "agent-memory"
          "fleet-reporter"
          "fleet-librarian"
          "inference-local-embed"
          "inference-local-rerank"
          "inference-local-small"
          "inference-local-medium"
          "inference-cloud-anthropic"
          "inference-cloud-google"
          "inference-cloud-openai"
          "inference-cloud-openrouter"
        ];
        runtimeBinsWords = lib.concatStringsSep " " runtimeBins;
        wrappedPath = lib.makeBinPath [ pkgs.bash pkgs.git pkgs.sqlite ];
        wrappedLibraries = lib.makeLibraryPath [ pkgs.stdenv.cc.cc ];
        package = pkgs.stdenv.mkDerivation {
          pname = "mini-volition";
          version = "0.1.0";
          src = builtins.path {
            path = ./.;
            name = "mini-volition-src";
          };
          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin" "$out/share/mini-volition" "$out/share/mini-volition/bin"
            cp -r README.md config docs prompts scripts "$out/share/mini-volition/"

            for name in ${runtimeBinsWords}; do
              if [ ! -x "bin/$name" ]; then
                echo "missing prebuilt runtime artifact: bin/$name" >&2
                echo "run 'bun install --frozen-lockfile && bun run scripts/build.ts' before nix build" >&2
                exit 1
              fi
              install -m755 "bin/$name" "$out/share/mini-volition/bin/$name"
              cat > "$out/bin/$name" <<EOF
#!/usr/bin/env bash
set -euo pipefail
package_root="$out/share/mini-volition"
state_root="''${XDG_STATE_HOME:-$HOME/.local/state}/mini-volition"
cache_root="''${XDG_CACHE_HOME:-$HOME/.cache}/mini-volition"
runtime_root="$state_root/runtime"
records_root="$state_root/state"
mkdir -p "$runtime_root" "$records_root" "$cache_root/transformers"
export META_REPO_ROOT="$package_root"
export PATH="${wrappedPath}:''${PATH:-}"
export LD_LIBRARY_PATH="${wrappedLibraries}${lib.optionalString pkgs.stdenv.isLinux ":$package_root/lib/onnxruntime/linux/${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}"}:''${LD_LIBRARY_PATH:-}"
export FLEET_STATE_DIR="''${FLEET_STATE_DIR:-$records_root}"
export INFERENCE_LOCAL_CACHE_DIR="''${INFERENCE_LOCAL_CACHE_DIR:-$cache_root/transformers}"
export AGENT_MAIL_DB="''${AGENT_MAIL_DB:-$runtime_root/agent-mail.db}"
export AGENT_JOBS_DB="''${AGENT_JOBS_DB:-$runtime_root/agent-jobs.db}"
export AGENT_MEMORY_DB="''${AGENT_MEMORY_DB:-$runtime_root/agent-memory.db}"
export AGENT_STATE_DB="''${AGENT_STATE_DB:-$runtime_root/agent-state.db}"
export FLEET_LIBRARIAN_DB="''${FLEET_LIBRARIAN_DB:-$runtime_root/fleet-librarian.db}"
export INFERENCE_CLOUD_ANTHROPIC_SOCKET="''${INFERENCE_CLOUD_ANTHROPIC_SOCKET:-$runtime_root/claude.sock}"
export INFERENCE_CLOUD_GOOGLE_SOCKET="''${INFERENCE_CLOUD_GOOGLE_SOCKET:-$runtime_root/gemini.sock}"
export INFERENCE_CLOUD_OPENAI_SOCKET="''${INFERENCE_CLOUD_OPENAI_SOCKET:-$runtime_root/openai.sock}"
export INFERENCE_CLOUD_OPENROUTER_SOCKET="''${INFERENCE_CLOUD_OPENROUTER_SOCKET:-$runtime_root/openrouter.sock}"
export INFERENCE_LOCAL_EMBED_SOCKET="''${INFERENCE_LOCAL_EMBED_SOCKET:-$runtime_root/embed.sock}"
export INFERENCE_LOCAL_RERANK_SOCKET="''${INFERENCE_LOCAL_RERANK_SOCKET:-$runtime_root/rerank.sock}"
export INFERENCE_LOCAL_SMALL_SOCKET="''${INFERENCE_LOCAL_SMALL_SOCKET:-$runtime_root/light.sock}"
export INFERENCE_LOCAL_MEDIUM_SOCKET="''${INFERENCE_LOCAL_MEDIUM_SOCKET:-$runtime_root/heavy.sock}"
exec "$package_root/bin/$name" "$@"
EOF
              chmod +x "$out/bin/$name"
            done

            runHook postInstall
          '';
          meta = {
            description = "Local-first multi-agent fleet runtime built with Bun";
            mainProgram = "fleet";
            platforms = lib.platforms.linux;
          };
        };
      in
      {
        packages.default = package;
        apps.default = {
          type = "app";
          program = "${package}/bin/fleet";
        };
        apps.fleet = {
          type = "app";
          program = "${package}/bin/fleet";
        };
        checks.package-smoke = pkgs.runCommand "mini-volition-package-smoke" {} ''
          test -x ${package}/bin/fleet
          test -x ${package}/bin/agent-mail
          mkdir -p "$out"
        '';
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ bun sqlite git ];
          shellHook = ''
            export META_REPO_ROOT=$(pwd)
            export PATH="$META_REPO_ROOT/bin:$PATH"
            echo "mini-volition dev shell active"
          '';
        };
      }
    );
}
