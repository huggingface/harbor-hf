export interface paths {
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    return_to?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            authenticated: boolean;
                            login_url?: string;
                            /** Format: date-time */
                            expires_at?: string;
                            actor?: {
                                username: string;
                                /** @enum {unknown} */
                                role: "operator" | "reader";
                                /** @enum {unknown} */
                                transport: "session" | "development";
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            authenticated: boolean;
                            login_url?: string;
                            /** Format: date-time */
                            expires_at?: string;
                            actor?: {
                                username: string;
                                /** @enum {unknown} */
                                role: "operator" | "reader";
                                /** @enum {unknown} */
                                transport: "session" | "development";
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            source_revision: string;
                            /** @enum {unknown} */
                            write_mode: "disabled" | "canary" | "enabled";
                            projection: {
                                ready: boolean;
                                rebuilding: boolean;
                                object_count: number;
                                last_rebuild_at: string | null;
                                last_sync_at: string | null;
                                event_cursor: string | null;
                                integrity_error: string | null;
                            };
                            resource_contract: {
                                [key: string]: number;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                campaign_id: string;
                                /** Format: date-time */
                                created_at: string;
                                status: string;
                                ceiling_microusd: number;
                                reserved_microusd: number;
                                observed_microusd: number;
                                total_tasks: number;
                                terminal_tasks: number;
                                admissible_tasks: number;
                                invalid_selected_tasks: number;
                                exhausted_tasks: number;
                                successful_tasks: number;
                                pending_actions: number;
                                publication_status: string | null;
                                cleanup_pending: boolean;
                                cancellation_requested: boolean;
                                paused: boolean;
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        benchmark: string;
                        model: string;
                        harness: string;
                        deployment?: string | null;
                        launch_policy: string;
                        ceiling_microusd: number;
                        confirmed: boolean;
                        /** @default false */
                        start_paused?: boolean;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            campaign_id: string;
                            action_id: string;
                            status_url: string;
                            adopted: boolean;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            campaign_id: string;
                            /** Format: date-time */
                            created_at: string;
                            status: string;
                            ceiling_microusd: number;
                            reserved_microusd: number;
                            observed_microusd: number;
                            total_tasks: number;
                            terminal_tasks: number;
                            admissible_tasks: number;
                            invalid_selected_tasks: number;
                            exhausted_tasks: number;
                            successful_tasks: number;
                            pending_actions: number;
                            publication_status: string | null;
                            cleanup_pending: boolean;
                            cancellation_requested: boolean;
                            paused: boolean;
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/capacity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            configured: boolean;
                            profile_id: string | null;
                            namespace_limit: number | null;
                            namespace_active: number;
                            campaign_limit: number;
                            campaign_active: number;
                            hardware_limit: number | null;
                            hardware_active: number;
                            provider_limit: number;
                            provider_reserved: number;
                            start_tokens: number | null;
                            start_burst: number | null;
                            queued: number;
                            cleanup_held: number;
                            limiting_factor: string | null;
                            not_before: string | null;
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/lock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            [key: string]: unknown;
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/prepared-job": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {unknown} */
                        phase: "trial";
                        task_id: string;
                        source_task_id: string;
                        trial_index: number;
                        input_digest: string;
                        trial_lock: {
                            [key: string]: unknown;
                        };
                        declared_image: string;
                        image: string;
                        cpus: number;
                        memory_mb: number;
                        storage_mb: number;
                        gpus: number;
                        agent_timeout_seconds: number;
                        verifier_timeout_seconds: number;
                        environment_build_timeout_seconds: number;
                        agent_setup_timeout_seconds: number;
                    } | {
                        /** @enum {unknown} */
                        phase: "finalize";
                        harbor_version: string;
                        job_config: {
                            [key: string]: unknown;
                        };
                        job_lock_header: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {unknown} */
                            phase: "trial" | "finalize";
                            record_id: string;
                            digest: string;
                            adopted: boolean;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/prepared-job/trials/{task_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            sandbox_id: string;
                            state: string;
                        };
                    };
                };
                /** @description Default Response */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            sandbox_id: string;
                            /** @enum {unknown} */
                            state: "QUEUED";
                            limiting_factor: string | null;
                            not_before: string | null;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/observe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                    sandbox_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/exec": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                    sandbox_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        command: string[];
                        cwd: string;
                        timeout_seconds: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                    sandbox_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        path: string;
                        content_digest: string;
                        content_base64: string;
                        mode?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}/files/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                    sandbox_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        path: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/sandboxes/{sandbox_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                    sandbox_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    campaign_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                campaign_id: string;
                                task_id: string;
                                input_digest: string;
                                terminal_outcome: string | null;
                                selected_attempt_id: string | null;
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            task: {
                                campaign_id: string;
                                task_id: string;
                                input_digest: string;
                                terminal_outcome: string | null;
                                selected_attempt_id: string | null;
                            };
                            attempts: {
                                attempt_id: string;
                                action_id: string;
                                campaign_id: string;
                                task_id: string;
                                outcome: string;
                                replacement_eligible: number;
                                cost_microusd: number;
                                metrics: {
                                    [key: string]: number;
                                };
                                /** Format: date-time */
                                created_at: string;
                            }[];
                            exhaustion: null | {
                                last_attempt_id: string;
                                attempt_count: number;
                                reason: string;
                                /** Format: date-time */
                                created_at: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/action-dispositions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                action_id: string;
                                campaign_id: string;
                                task_id: string;
                                recorded_outcome: string;
                                recorded_observed_state: string;
                                effective_outcome: string;
                                effective_observed_state: string;
                                effective_error_code: string;
                                reason_code: string;
                                /** Format: date-time */
                                corrected_at: string;
                                actor_role: string;
                                disposition_record_id: string;
                                batch_id: string;
                                batch_size: number;
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        action_ids: string[];
                        reason: string;
                        /** @enum {unknown} */
                        confirmed: true;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            batch_id: string;
                            batch_digest: string;
                            items: {
                                action_id: string;
                                disposition_record_id: string;
                                created: boolean;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            batch_id: string;
                            batch_digest: string;
                            items: {
                                action_id: string;
                                disposition_record_id: string;
                                created: boolean;
                            }[];
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {unknown} */
                        action: "cancel" | "retry_infrastructure" | "publish" | "pause_endpoint" | "pause" | "resume" | "supersede";
                        task_id?: string | null;
                        reason?: string | null;
                        confirmed: boolean;
                        task_limit?: number | null;
                        publication_id?: string | null;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            campaign_id: string;
                            action_id: string;
                            status_url: string;
                            adopted: boolean;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/campaigns/{campaign_id}/tasks/{task_id}/attempts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    campaign_id: string;
                    task_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {unknown} */
                        outcome: "complete" | "invalid" | "infrastructure" | "semantic" | "refusal" | "verifier" | "agent" | "benchmark_timeout" | "cancelled" | "policy";
                        replacement_eligible: boolean;
                        evidence_digest: string;
                        evidence_path: string;
                        cost_microusd: number;
                        /** Format: date-time */
                        completed_at: string;
                        /** @enum {unknown} */
                        confirmed: true;
                        metrics: {
                            [key: string]: number;
                        };
                        action_id: string;
                    } | {
                        /** @enum {unknown} */
                        operation: "upload_evidence";
                        action_id: string;
                        digest: string;
                        content_base64: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            path: string;
                            digest: string;
                            size: number;
                            created: boolean;
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            path: string;
                            digest: string;
                            size: number;
                            created: boolean;
                        };
                    };
                };
                /** @description Default Response */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            campaign_id: string;
                            task_id: string;
                            attempt_id: string;
                            status_url: string;
                            adopted: boolean;
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
                /** @description Default Response */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    campaign_id?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                action_id: string;
                                campaign_id: string;
                                action_kind: string;
                                generation: number;
                                target: string;
                                outcome: string | null;
                                observed_state: string | null;
                                resource_id: string | null;
                                /** Format: date-time */
                                created_at: string;
                                inspect_url: string | null;
                                cost_microusd: number;
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/endpoints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                action_id: string;
                                campaign_id: string;
                                endpoint_id: string;
                                desired_state: string;
                                observed_state: string;
                                ready_replicas: number;
                                cleanup_verified: number;
                                active_hourly_cost_microusd: number;
                                /** Format: date-time */
                                created_at: string;
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                profile_id: string;
                                profile_kind: string;
                                name: string;
                                source: string;
                                promotion_state: string | null;
                                alias: string | null;
                                approved_aliases: string[];
                                spec: {
                                    [key: string]: unknown;
                                };
                                /** Format: date-time */
                                created_at: string;
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/results": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    model?: string;
                    benchmark?: string;
                    agent?: string;
                    status?: string;
                    search?: string;
                    published_after?: string;
                    published_before?: string;
                    sort?: "published_at" | "model" | "benchmark" | "status" | "score";
                    order?: "asc" | "desc";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                publication_id: string;
                                campaign_id: string;
                                status: string;
                                catalog_digest: string | null;
                                /** Format: date-time */
                                published_at: string;
                                run_id?: string | null;
                                benchmark?: string | null;
                                model?: string | null;
                                harness?: string | null;
                                inference_provider?: string | null;
                                run_outcome?: string | null;
                                quality?: string | null;
                                publication_role?: string | null;
                                task_count?: number | null;
                                scored_task_count?: number | null;
                                strict_pass_count?: number | null;
                                primary_metric?: {
                                    name: string;
                                    value: number;
                                    unit: string;
                                } | null;
                                result_path?: string | null;
                                pass_count?: number | null;
                                pass_rate?: number | null;
                                pass_rate_ci95?: {
                                    low: number;
                                    high: number;
                                } | null;
                                input_tokens?: number | null;
                                output_tokens?: number | null;
                                inference_cost_microusd?: number | null;
                                mean_task_cost_microusd?: number | null;
                                task_cost_ci95?: {
                                    low: number;
                                    high: number;
                                } | null;
                                observed_cost_microusd?: number | null;
                                outputs_prefix?: string | null;
                                outputs_url?: string | null;
                                hf_uri?: string | null;
                                tasks?: {
                                    task_id: string;
                                    outcome: string;
                                    reward: number | null;
                                    cost_microusd: number;
                                    input_tokens: number | null;
                                    output_tokens: number | null;
                                }[];
                                benchmark_revision?: string | null;
                                model_revision?: string | null;
                                harness_revision?: string | null;
                                agent?: string | null;
                                source_revision?: string | null;
                                catalog_source_digest?: string | null;
                                superseded_by_publication_id?: string | null;
                                profile_ids?: {
                                    [key: string]: string;
                                };
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/results/{publication_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    publication_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            publication_id: string;
                            campaign_id: string;
                            status: string;
                            catalog_digest: string | null;
                            /** Format: date-time */
                            published_at: string;
                            run_id?: string | null;
                            benchmark?: string | null;
                            model?: string | null;
                            harness?: string | null;
                            inference_provider?: string | null;
                            run_outcome?: string | null;
                            quality?: string | null;
                            publication_role?: string | null;
                            task_count?: number | null;
                            scored_task_count?: number | null;
                            strict_pass_count?: number | null;
                            primary_metric?: {
                                name: string;
                                value: number;
                                unit: string;
                            } | null;
                            result_path?: string | null;
                            pass_count?: number | null;
                            pass_rate?: number | null;
                            pass_rate_ci95?: {
                                low: number;
                                high: number;
                            } | null;
                            input_tokens?: number | null;
                            output_tokens?: number | null;
                            inference_cost_microusd?: number | null;
                            mean_task_cost_microusd?: number | null;
                            task_cost_ci95?: {
                                low: number;
                                high: number;
                            } | null;
                            observed_cost_microusd?: number | null;
                            outputs_prefix?: string | null;
                            outputs_url?: string | null;
                            hf_uri?: string | null;
                            tasks?: {
                                task_id: string;
                                outcome: string;
                                reward: number | null;
                                cost_microusd: number;
                                input_tokens: number | null;
                                output_tokens: number | null;
                            }[];
                            benchmark_revision?: string | null;
                            model_revision?: string | null;
                            harness_revision?: string | null;
                            agent?: string | null;
                            source_revision?: string | null;
                            catalog_source_digest?: string | null;
                            superseded_by_publication_id?: string | null;
                            profile_ids?: {
                                [key: string]: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                request_id: string;
                                fields?: {
                                    [key: string]: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                id: string;
                                type: string;
                                /** Format: date-time */
                                occurred_at: string;
                                data: {
                                    [key: string]: unknown;
                                };
                            }[];
                            next_cursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
