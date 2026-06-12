from __future__ import annotations

import json
import os
import subprocess
import time
from typing import Any, Callable

from server.command_schema import Command


def default_mission_for_command(cmd: Command) -> str:
    labels = {
        'inspect_repo': f'Inspeccionar repo {cmd.target} y reportar hallazgos accionables.',
        'read_file': f'Leer {cmd.target} y resumir contenido relevante.',
        'run_tests': f'Ejecutar tests en {cmd.target}, diagnosticar fallos y proponer corrección.',
        'run_build': f'Ejecutar build en {cmd.target}, diagnosticar fallos y proponer corrección.',
        'edit_file': f'Editar/proponer cambios en {cmd.target} según la instrucción del usuario.',
        'create_branch': f'Crear/preparar rama de trabajo para {cmd.target}.',
        'git_commit': f'Preparar commit limpio para {cmd.target}, con resumen verificable.',
        'delete_file': f'Eliminar {cmd.target} solo si la aprobación explícita lo autoriza y reportar impacto.',
        'send_message': f'Preparar/enviar mensaje relacionado con {cmd.target} según política aprobada.',
        'execute_agent': f'Ejecutar misión agente sobre {cmd.target}.',
        'unit_command': f'Ejecutar misión de unidad sobre {cmd.target}.',
    }
    return labels.get(cmd.type, f'Ejecutar comando {cmd.type} sobre {cmd.target}.')


def register_issue_run(payload: dict[str, Any], run_id: str, register_run: Callable[[str, str, str], Any]) -> None:
    issue_id = str(payload.get('issueId') or payload.get('issue_id') or '')
    repo = str(payload.get('repo') or payload.get('target') or '')
    if not issue_id or not repo:
        return
    try:
        register_run(repo, issue_id, run_id)
    except Exception:
        pass


def dispatch_command(
    cmd: Command,
    *,
    run_agent: Callable[..., None],
    send_to_repociv: Callable[[dict[str, Any]], None],
    append_pending_task: Callable[[str, str], Any],
    save_mission: Callable[[dict[str, Any]], None],
    infer_adapter_for_command: Callable[[str, str], Any],
    sessions_patch: Callable[..., Any],
    sessions_append_message: Callable[..., Any],
    run_state_save: Callable[[str, dict[str, Any]], Any],
    event_record_output_chunk: Callable[[str, str, str], Any],
    event_record_completed: Callable[[str, str], Any],
    event_record_failed: Callable[[str, str], Any],
    record_outcome: Callable[[str, str, float], Any],
    register_issue_run_fn: Callable[[dict[str, Any], str], None],
    task_run: Callable[[str, str], dict[str, Any]],
    subagent_approve_spawn: Callable[[str], Any],
    subagent_request_dispatch: Callable[..., dict[str, Any]],
) -> None:
    payload = cmd.payload

    agent_command_types = {
        'unit_command', 'execute_agent', 'inspect_repo', 'read_file',
        'run_tests', 'run_build', 'edit_file', 'create_branch',
        'git_commit', 'delete_file', 'send_message',
    }

    if cmd.type in agent_command_types:
        unit = str(payload.get('unit', 'MAIN'))
        city = str(payload.get('city', cmd.target or 'main'))
        mission = str(payload.get('mission') or default_mission_for_command(cmd))
        agent_type = str(payload.get('agentType', 'hero'))
        harness = str(payload.get('harness', ''))
        provider = str(payload.get('provider', ''))
        model = str(payload.get('model', ''))
        repo_path = str(payload.get('repoPath') or payload.get('cwd') or '')
        file_path = str(payload.get('filePath') or '')
        run_agent(unit, city, mission, agent_type, cmd.id,
                  harness=harness, provider=provider, model=model,
                  repo_path=repo_path, file_path=file_path)
        register_issue_run_fn(payload, cmd.id)
        return

    if cmd.type == 'e2e_probe':
        unit = str(payload.get('unit', 'MAIN'))
        marker = str(payload.get('marker', cmd.id))[:120]
        quest_name = f'E2E probe: {marker}'
        text = f'E2E probe completado: {marker}'
        adapter = infer_adapter_for_command('e2e_probe', str(cmd.harness_id or ''))
        runtime_id = adapter.harness_id if adapter else 'local-cli'
        sessions_patch(unit, runtimeId=runtime_id, repo=str(cmd.target or 'main'), summary=quest_name, lastMissionId=cmd.id)
        sessions_append_message(unit, 'user', marker, {'missionId': cmd.id, 'kind': 'e2e_probe'})
        run_state_save(cmd.id, {
            'unitId': unit,
            'runtimeId': runtime_id,
            'repo': str(cmd.target or 'main'),
            'commandType': 'e2e_probe',
            'phase': 'completed',
            'status': 'completed',
            'retries': 0,
            'checkpointApproved': [],
            'filesTouched': [],
            'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'result': text,
        })
        send_to_repociv({'type': 'mission_start', 'missionId': cmd.id, 'unit': unit, 'questName': quest_name})
        send_to_repociv({'type': 'chat_chunk', 'unit': unit, 'text': text, 'missionId': cmd.id})
        event_record_output_chunk(cmd.id, unit, text)
        event_record_completed(cmd.id, text)
        send_to_repociv({'type': 'mission_complete', 'missionId': cmd.id, 'unit': unit, 'success': True, 'duration': 0})
        send_to_repociv({'type': 'log', 'msg': text, 'level': 'success'})
        register_issue_run_fn(payload, cmd.id)
        return

    if cmd.type == 'subagent_spawn':
        subagent_approve_spawn(cmd.id)
        event_record_completed(cmd.id, 'subagent_spawn approved')
        send_to_repociv({'type': 'log', 'msg': f'Subagente aprobado: {cmd.target}', 'level': 'success'})
        return

    if cmd.type == 'subagent_dispatch':
        result = subagent_request_dispatch(
            parent_mission_id=str(payload.get('parentMissionId', '')),
            parent_unit=str(payload.get('parentUnit', cmd.target)),
            kind=str(payload.get('kind', 'generalPurpose')),
            label=str(payload.get('label', '')),
            harness=str(payload.get('harness', '')),
        )
        event_record_failed(cmd.id, result.get('error', 'not_implemented'))
        send_to_repociv({
            'type': 'log',
            'msg': '[swarm] subagent_dispatch no implementado (fase 2)',
            'level': 'warn',
        })
        return

    if cmd.type == 'quest_add':
        title = str(payload.get('title', cmd.target or ''))
        description = str(payload.get('description', ''))
        append_pending_task(title, description)
        mission_rec: dict[str, Any] = {
            'id': cmd.id, 'unit': 'MAIN', 'city': 'main', 'mission': title,
            'questName': title, 'agentType': 'hero', 'startedAt': time.time(),
            'completedAt': time.time(), 'status': 'complete', 'summary': description,
            'lines': 0, 'duration': 0,
        }
        save_mission(mission_rec)
        adapter = infer_adapter_for_command('quest_add', cmd.harness_id)
        runtime_id = adapter.harness_id if adapter else 'local-cli'
        sessions_patch('MAIN', runtimeId=runtime_id, repo='main', summary=title, lastMissionId=cmd.id)
        sessions_append_message('MAIN', 'user', title, {'missionId': cmd.id, 'kind': 'quest_add'})
        if description:
            sessions_append_message('MAIN', 'assistant', description, {'missionId': cmd.id, 'kind': 'quest_add_summary'})
        run_state_save(cmd.id, {
            'unitId': 'MAIN',
            'runtimeId': runtime_id,
            'repo': 'main',
            'commandType': 'quest_add',
            'phase': 'completed',
            'status': 'completed',
            'retries': 0,
            'checkpointApproved': [],
            'filesTouched': [],
            'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'result': description,
        })
        send_to_repociv({'type': 'mission_start', 'missionId': cmd.id, 'unit': 'MAIN', 'questName': title})
        send_to_repociv({'type': 'mission_complete', 'missionId': cmd.id, 'unit': 'MAIN', 'success': True, 'duration': 0})
        send_to_repociv({'type': 'log', 'msg': f'Quest agregado: {title}', 'level': 'success'})
        event_record_completed(cmd.id, 'quest added')
        record_outcome(cmd.id, 'success', 0.0)
        return

    if cmd.type == 'open_file':
        fp = str(payload.get('filePath', '')).strip()
        if not fp or not os.path.exists(fp):
            send_to_repociv({'type': 'log', 'msg': f'open_file: ruta no encontrada: {fp!r}', 'level': 'warn'})
            event_record_failed(cmd.id, 'path not found')
            return
        try:
            is_dir = os.path.isdir(fp)
            wpath_result = subprocess.run(['wslpath', '-w', fp], capture_output=True, text=True, timeout=3)
            if wpath_result.returncode == 0:
                win_path = wpath_result.stdout.strip()
                if is_dir:
                    subprocess.Popen(['explorer.exe', win_path])
                else:
                    subprocess.Popen(['code', '--reuse-window', fp])
            else:
                subprocess.Popen(['xdg-open', fp])
            send_to_repociv({'type': 'log', 'msg': f'Abriendo: {fp}', 'level': 'info'})
            event_record_completed(cmd.id, fp)
            record_outcome(cmd.id, 'success', 0.0)
        except Exception as exc:
            send_to_repociv({'type': 'log', 'msg': f'open_file error: {exc}', 'level': 'error'})
            event_record_failed(cmd.id, str(exc))
        return

    if cmd.type == 'tile_inspected':
        city_name = str(payload.get('cityName', cmd.target))
        send_to_repociv({'type': 'log', 'msg': f'Inspeccionando: {city_name}', 'level': 'info'})
        event_record_completed(cmd.id, 'tile inspected')
        record_outcome(cmd.id, 'success', 0.0)
        return

    if cmd.type == 'task_run':
        repo = str(payload.get('repo', cmd.target))
        issue_id = str(payload.get('issueId') or payload.get('issue_id') or '')
        if not issue_id:
            event_record_failed(cmd.id, 'task_run requires issueId in payload')
            return
        try:
            result = task_run(repo, issue_id)
            event_record_completed(cmd.id, json.dumps({'phase': result.get('phase'), 'repo': repo, 'issueId': issue_id}))
            send_to_repociv({
                'type': 'task_complete', 'repo': repo, 'issueId': issue_id,
                'phase': result.get('phase'), 'missionId': cmd.id,
            })
        except Exception as e:
            event_record_failed(cmd.id, str(e))
            send_to_repociv({
                'type': 'task_failed', 'repo': repo, 'issueId': issue_id,
                'error': str(e), 'missionId': cmd.id,
            })
        return

    send_to_repociv({'type': 'log', 'msg': f'Comando {cmd.type} sin executor — sin ejecución real', 'level': 'warn'})
    event_record_failed(cmd.id, f'no executor for {cmd.type}')
    record_outcome(cmd.id, 'failure', 0.0)
    send_to_repociv({
        'type': 'mission_complete',
        'missionId': cmd.id,
        'unit': str(cmd.payload.get('unit', 'MAIN')),
        'success': False,
        'duration': 0,
        'error': f"Sin executor para tipo '{cmd.type}' — no se ejecutó ninguna acción real",
    })
