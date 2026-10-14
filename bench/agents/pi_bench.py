"""Harbor agents for the pi-episodes benchmark.

Both arms are Harbor's built-in pi adapter with the same pi version, packages, model and
settings. `PiEpisodes` also installs pi-episodes; nothing else differs. After each trial,
both read the pi session file with `bench/scripts/stats.ts` and attach the numbers to the
trial's `result.json` under `agent_result.metadata`.
"""

import json
import shlex
import subprocess
from pathlib import Path

from harbor.agents.installed.pi import (
    _PI_CONFIG_DIR_ENV,
    _REMOTE_PI_CONFIG_DIR,
    Pi,
    PiOptions,
)
from harbor.agents.model_connection import ResolvedModelConnection
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field

REPO = Path(__file__).resolve().parents[2]
STATS_TIMEOUT_SEC = 120


class BenchOptions(PiOptions):
    packages: list[str] = Field(
        default_factory=list,
        description="Pi package sources installed in both arms, such as a model provider.",
    )
    package_provider: bool = Field(
        default=False,
        description=(
            "The model's provider comes from one of `packages` and reads its endpoint "
            "from agent env vars. Skips the adapter's custom-endpoint models.json, which "
            "it would otherwise write for any `<PROVIDER>_BASE_URL` it sees."
        ),
    )


class EpisodesOptions(BenchOptions):
    episodes: str = Field(
        description=(
            "pi-episodes to install: a `pnpm pack` tarball on the host, or a pi package "
            "source such as npm:pi-episodes@0.3.0."
        ),
    )


class PiBench(Pi):
    """Plain pi: the baseline arm."""

    options_model = BenchOptions
    options: BenchOptions

    @staticmethod
    def name() -> str:
        return "pi"

    def _uses_isolated_config(self) -> bool:
        # Mirrors Pi.run, which moves pi's config dir when it writes models.json or MCP config.
        if self.mcp_servers:
            return True
        if self.options.package_provider:
            return False
        return self.model_connection.configured_base_url is not None

    def _pi(self, args: str) -> str:
        """A pi command line, with node from the adapter's nvm install on PATH."""
        prefix = (
            f"{_PI_CONFIG_DIR_ENV}={shlex.quote(_REMOTE_PI_CONFIG_DIR.as_posix())} "
            if self._uses_isolated_config()
            else ""
        )
        return f". ~/.nvm/nvm.sh && {prefix}pi {args}"

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        for source in self.options.packages:
            await self.exec_as_agent(
                environment, command=self._pi(f"install {shlex.quote(source)}")
            )

    def _build_custom_models_json(
        self, access: ResolvedModelConnection, model_id: str
    ) -> dict | None:
        if self.options.package_provider:
            return None
        return super()._build_custom_models_json(access, model_id)

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        sessions = sorted(
            (self.logs_dir / self._SESSIONS_DIRECTORY).glob("*.jsonl"),
            key=lambda path: (path.stat().st_mtime_ns, path.name),
        )
        if not sessions:
            return
        try:
            result = subprocess.run(
                [
                    "node",
                    "--import",
                    "tsx",
                    str(REPO / "bench/scripts/stats.ts"),
                    str(sessions[-1]),
                ],
                capture_output=True,
                text=True,
                timeout=STATS_TIMEOUT_SEC,
                check=True,
                cwd=REPO,
            )
            context.metadata = {**(context.metadata or {}), **json.loads(result.stdout)}
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            # The report recomputes from the session file, so a failure here loses nothing.
            self.logger.warning(
                f"Could not read episode stats from {sessions[-1]}: {exc}"
            )


class PiEpisodes(PiBench):
    """Pi with pi-episodes."""

    options_model = EpisodesOptions
    options: EpisodesOptions

    @staticmethod
    def name() -> str:
        return "pi-episodes"

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        source = self.options.episodes
        if not source.endswith(".tgz"):
            await self.exec_as_agent(
                environment, command=self._pi(f"install {shlex.quote(source)}")
            )
            return

        remote = "/tmp/pi-episodes.tgz"
        await environment.upload_file(source, remote)
        # Peer dependencies are pi's own packages, which pi provides to extensions at runtime.
        await self.exec_as_agent(
            environment,
            command=(
                'set -euo pipefail; dir="$HOME/.pi-episodes"; mkdir -p "$dir" && '
                f'tar -xzf {remote} --strip-components=1 -C "$dir" && cd "$dir" && '
                ". ~/.nvm/nvm.sh && npm install --omit=dev --omit=peer --ignore-scripts "
                "--no-audit --no-fund && " + self._pi('install "$dir"')
            ),
        )
