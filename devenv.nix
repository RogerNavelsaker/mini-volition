{ pkgs, inputs, ... }:

let
  system = pkgs.stdenv.hostPlatform.system;
in
{
  packages = with pkgs; [
    bun
    coreutils
    findutils
    gawk
    gh
    git
    jq
    ripgrep
    sqlite
    inputs."claude-code".packages.${system}.default.cc
    inputs."codex".packages.${system}.default.cod
    gemini-cli
    inputs.canopy.packages.${system}.default.cn
    inputs.mulch.packages.${system}.default.ml
    inputs.seeds.packages.${system}.default.sd
    inputs.trellis.packages.${system}.default.tl
  ];

  enterShell = ''
    export META_REPO_ROOT="$(pwd)"
    export PATH="$META_REPO_ROOT/bin:$PATH"
    echo "mini-volition devenv active"
  '';
}
