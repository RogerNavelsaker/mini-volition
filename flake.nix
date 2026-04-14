{
  description = "mini-volition: A local ACP-based fleet runtime";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "fleet-runtime";
          version = "0.1.0";
          src = ./.;
          buildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            mkdir -p $out/bin
            mkdir -p $out/share/mini-volition
            cp -r . $out/share/mini-volition/
            
            for bin in bin/*; do
              basename=$(basename "$bin")
              makeWrapper "$out/share/mini-volition/bin/$basename" "$out/bin/$basename" \
                --set-default META_REPO_ROOT "$out/share/mini-volition" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun pkgs.sqlite ]}
            done
          '';
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ bun sqlite zellij flox ];
          shellHook = ''
            export META_REPO_ROOT=$(pwd)
            export PATH="$META_REPO_ROOT/bin:$PATH"
            echo "mini-volition dev shell active"
          '';
        };
      }
    );
}
