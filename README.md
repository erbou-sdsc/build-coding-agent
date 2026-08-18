# Build Coding Agent

## Description

This proof of concept (PoC) demonstrates how to run an agent harness in a sidecar container within a Kubernetes cluster while sharing a tmux session with the user's frontend container.

## Prerequisites

To run this PoC, you need:

- A Teleport account.
- kubectl installed and configured.
- tsh (the Teleport CLI) installed on your local machine.

## Limitations

Note: This is a proof of concept (PoC) and should only be used to validate the ability to share a tmux session between the user's frontend container and the agent harness running in a sidecar.

The sidecar configuration does not enforce any restrictions on the resources available to the sandboxed agent. As a result, it should not be considered a secure or production-ready setup.

The overall configuration is intentionally minimal. In particular, the default tmux server configuration in the sidecar is very basic and could be significantly improved to provide a better user experience.

## How to:

### Login to teleport

> tsh login --auth=github --proxy=teleport.dev.renku.ch:443 teleport.dev.renku.ch
> tsh kube login teleport.dev.renku.ch

### Patch an existing renku instance

#### Start a renku session

Start the instance, then note the namespace and the session id from the URL.

> https://**namespace**.dev.renku.ch/p/group/coding-agent/sessions/show/**session-id**

#### Patch the instance

> ./patch.py --namespace **namespace** --ams **session-id**

### Deploy and test a standalone yaml for testing purposes

#### Create a k8s namespace

> tsh kubcetl create namespace <mynamespace>

#### Deploy the coding agent test case on k8s

E.g. apply the sample _agent-harness.yaml_.

> tsh kubectl -n **namespace** apply -f agent-harness.yaml
> tsh kubectl -n **namespace** get pods
> tsh kubectl -n **namespace** port-forward svc/test-coding-agent 8081:8000

(1) get pods must show 2/2 pods ready

#### Exec in main container

> tsh kubectl -n **namespace** exec -it deploy/test-coding-agent -c coding-agent -- bash

#### Exec in sidecar

> tsh kubectl -n **namespace** exec -it deploy/test-coding-agent -c agent-harness-sandbox-- bash

#### Open in browser

open http://localhost:8081

#### In browser frontend UI

- Open a terminal
- Run one of `pi-sbx`, `claude-sbx`, or `codex-sbx`

Each command attaches to a tmux session running the agent harness. The sidecar supervises the session and restarts it if it exits or is stopped (including via tmux commands). On restart, the session is restored to its previous state so work can continue where it left off.

WIP: resumable sessions to where it left off tested on _pi-sbx_, unverified on _claude-sbx_ and _codex-sbx_

#### Delete the kubernetes pod

> tsh kubectl -n **namespace** delete deployment test-coding-agent

## References:
- [notion](https://www.notion.so/renku/Coding-Agents-in-Renku-Build-Team-3570df2efafc80ef9024c6736b4682bc?source=copy_link)
