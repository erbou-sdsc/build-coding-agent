#!/usr/bin/env python3

import json
import subprocess
import argparse

if __name__ == '__main__':
    """
    Patch renku session with a coding agent harness sandboxed
    in a sidecar container as shown below.
    Values shown as `...` are copied from the session container.

    extraContainers:
      - name: sbx-sidecar
        image: ghcr.io/erbou-sdsc/renku-frontend-buildpacks/coding-agent-vscodium:0.7.2
        command:
          - /cnb/process/harness-sbx
        env:
        - name: RENKU_MOUNT_DIR
          value: `...`
        - name: RENKU_WORKING_DIR
          value: `...`
        - name: RENKU_PROJECT_ID
          value: `...`
        - name: RENKU_PROJECT_PATH
          value: `...`
        - name: RENKU_LAUNCHER_ID
          value: `...`
        - name: CNB_APP_DIR
          value: `...`
        imagePullPolicy: Always
        resources:
          limits:
            memory: `...`
          requests:
            cpu: `...`
            memory: `...`
        securityContext:
          runAsGroup: `...`
          runAsUser: `...`
        volumeMounts:
          - mountPath: `...`
            name: amalthea-volume
        workingDir: `...`
    """
    parser = argparse.ArgumentParser(
            prog='patch',
            description='patch a renku session with an agent sandboxing sidecar',
    )

    parser.add_argument('--ams', '-a', type=str, required=True, help="Configuration Id")
    parser.add_argument('--namespace', '-n', type=str, required=True, help="Namespace")
    parser.add_argument('--apply', '-f', action='store_true', help="Apply the patch")

    args = parser.parse_args()

    output = subprocess.run(["tsh", "kubectl", "-n", args.namespace, "get", "ams", args.ams, "-o", "json"], capture_output=True)

    if not output.returncode:  
        obj = json.loads(output.stdout)
        obj["spec"]["extraContainers"] = {
                "name": "sbx-sidecar",
                "image": obj["spec"]["session"]["image"],
                "command": ["/cnb/process/harness-sbx"],
                "env": [
                    { "name": v["name"], "value": v["value"] } for v in obj["spec"]["session"]["env"] if v["name"] in [
                        "RENKU_MOUNT_DIR",
                        "RENKU_WORKING_DIR",
                        "RENKU_PROJECT_ID",
                        "RENKU_PROJECT_PATH",
                        "RENKU_LAUNCHER_ID",
                        "CNB_APP_DIR"
                    ] 
                ],
                "imagePullPolicy": "Always",
                "resources": obj["spec"]["session"]["resources"],
                "securityContext": {
                    "runAsGroup": obj["spec"]["session"]["runAsGroup"],
                    "runAsUser":  obj["spec"]["session"]["runAsUser"],
                },
                "volumeMounts": [
                    {
                        "name": "amalthea-volume",
                        "mountPath": obj["spec"]["session"]["storage"]["mountPath"],
                    }
                ],
                "workingDir": obj["spec"]["session"]["workingDir"],
        }
        config = json.dumps(obj, indent=4)
        print(config)
        if args.apply:
            result = subprocess.run(
                ["tsh", "kubectl", "-n", args.namespace, "apply", "-f", "-"],
                input=config,
                text=True,
                capture_output=True,
            )
            if not result.returncode:
                print("=== Config was applied ===")
                print(result.stdout)
            else:
                print("=== Error while applying config ===")
                print(result.stderr)

    else:
        print(output.stderr)
