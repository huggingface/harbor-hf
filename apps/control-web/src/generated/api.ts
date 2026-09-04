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
        /** @description Reports control initialization without failing the hosting platform health check. */
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
                            /** @enum {unknown} */
                            status: "initializing" | "ready";
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
                                role: "operator" | "reader" | "submitter";
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
                                role: "operator" | "reader" | "submitter";
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
                            write_mode: "disabled" | "enabled";
                            initialization: {
                                ready: boolean;
                                /** @enum {unknown} */
                                status: "initializing" | "ready";
                            };
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
    "/api/v1/capacity": {
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
                            alias: string | null;
                            configured: boolean;
                            max_active_jobs: number | null;
                            start_burst: number | null;
                            start_refill_tokens: number | null;
                            start_refill_period_seconds: number | null;
                            profile_id: string | null;
                            active_jobs: number;
                            available_jobs: number | null;
                            queued_jobs: number;
                            observed_running_jobs: number;
                            observed_scheduling_jobs: number;
                            reserved_without_active_observation: number;
                            start_tokens: number | null;
                            runs: {
                                run_id: string;
                                max_active_jobs: number;
                                active_jobs: number;
                                available_jobs: number;
                            }[];
                            hardware: {
                                hardware: string;
                                max_active_jobs: number;
                                active_jobs: number;
                                available_jobs: number;
                            }[];
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
                        max_active_jobs: number;
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
                            alias: string | null;
                            configured: boolean;
                            max_active_jobs: number | null;
                            start_burst: number | null;
                            start_refill_tokens: number | null;
                            start_refill_period_seconds: number | null;
                            profile_id: string | null;
                        };
                    };
                };
                /** @description Default Response */
                503: {
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
    "/api/v1/workbench/preview": {
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
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {unknown} */
                        schema_version: "v1";
                        name: string;
                        setup_command: string;
                        run_command: string;
                        /** @enum {unknown} */
                        route_api: "chat-completions" | "responses";
                        setup_timeout_seconds: number;
                        environment: {
                            name: string;
                            /** @enum {unknown} */
                            source: "literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key";
                            value?: string;
                        }[];
                        outputs: {
                            results_path: string;
                            trajectory_path: null | string;
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
                            recipe: {
                                [key: string]: unknown;
                            };
                            recipe_digest: string;
                            revision_id: string;
                            setup_command: string;
                            run_command: string;
                            environment: {
                                name: string;
                                source: string;
                                value: string;
                                redacted: boolean;
                            }[];
                            harness_profile: {
                                [key: string]: unknown;
                            };
                            warnings: string[];
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
    "/api/v1/workbench/configurations": {
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
                            items: {
                                /** @enum {unknown} */
                                schema_version: "v1";
                                revision: string;
                                /** Agent Workbench recipe v1 */
                                recipe: {
                                    /** @enum {unknown} */
                                    schema_version: "v1";
                                    name: string;
                                    setup_command: string;
                                    run_command: string;
                                    /** @enum {unknown} */
                                    route_api: "chat-completions" | "responses";
                                    setup_timeout_seconds: number;
                                    environment: {
                                        name: string;
                                        /** @enum {unknown} */
                                        source: "literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key";
                                        value?: string;
                                    }[];
                                    outputs: {
                                        results_path: string;
                                        trajectory_path: null | string;
                                    };
                                };
                            }[];
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
                        /** @enum {unknown} */
                        schema_version: "v1";
                        name: string;
                        setup_command: string;
                        run_command: string;
                        /** @enum {unknown} */
                        route_api: "chat-completions" | "responses";
                        setup_timeout_seconds: number;
                        environment: {
                            name: string;
                            /** @enum {unknown} */
                            source: "literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key";
                            value?: string;
                        }[];
                        outputs: {
                            results_path: string;
                            trajectory_path: null | string;
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
                            schema_version: "v1";
                            revision: string;
                            /** Agent Workbench recipe v1 */
                            recipe: {
                                /** @enum {unknown} */
                                schema_version: "v1";
                                name: string;
                                setup_command: string;
                                run_command: string;
                                /** @enum {unknown} */
                                route_api: "chat-completions" | "responses";
                                setup_timeout_seconds: number;
                                environment: {
                                    name: string;
                                    /** @enum {unknown} */
                                    source: "literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key";
                                    value?: string;
                                }[];
                                outputs: {
                                    results_path: string;
                                    trajectory_path: null | string;
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
    "/api/v1/workbench/benchmark-configs": {
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
                            items: {
                                name: string;
                                /** @enum {unknown} */
                                size: "small" | "medium" | "large";
                                revision: string;
                                label: string;
                                description: string;
                                benchmark: string;
                                model: string;
                                deployment: string;
                                launch_policy: string;
                                default_ceiling_microusd: number;
                                max_ceiling_microusd: number;
                                task_count: number;
                                /** @enum {unknown} */
                                publication_role: "final" | "component" | "diagnostic";
                            }[];
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
    "/api/v1/workbench/local-runs/options": {
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
                            enabled: boolean;
                            ready: boolean;
                            reason: string | null;
                            benchmark: string;
                            model: string;
                            task_names: string[];
                            harbor_version: string | null;
                            expected_harbor_version: string | null;
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
    "/api/v1/workbench/local-runs/preview": {
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
            requestBody: {
                content: {
                    "application/json": {
                        /** Agent Workbench recipe v1 */
                        recipe: {
                            /** @enum {unknown} */
                            schema_version: "v1";
                            name: string;
                            setup_command: string;
                            run_command: string;
                            /** @enum {unknown} */
                            route_api: "chat-completions" | "responses";
                            setup_timeout_seconds: number;
                            environment: {
                                name: string;
                                /** @enum {unknown} */
                                source: "literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key";
                                value?: string;
                            }[];
                            outputs: {
                                results_path: string;
                                trajectory_path: null | string;
                            };
                        };
                        task_names: string[];
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
                            config: {
                                [key: string]: unknown;
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
    "/api/v1/workbench/local-runs": {
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
                            local_run_id: string;
                            recipe_digest: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
                            benchmark: string;
                            model: string;
                            task_names: string[];
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            config_path: string;
                            result_path: string | null;
                            command: string[];
                        }[];
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
                        /** Agent Workbench recipe v1 */
                        recipe: {
                            /** @enum {unknown} */
                            schema_version: "v1";
                            name: string;
                            setup_command: string;
                            run_command: string;
                            /** @enum {unknown} */
                            route_api: "chat-completions" | "responses";
                            setup_timeout_seconds: number;
                            environment: {
                                name: string;
                                /** @enum {unknown} */
                                source: "literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key";
                                value?: string;
                            }[];
                            outputs: {
                                results_path: string;
                                trajectory_path: null | string;
                            };
                        };
                        task_names: string[];
                        /** @enum {unknown} */
                        confirmed: true;
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
                            local_run_id: string;
                            recipe_digest: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
                            benchmark: string;
                            model: string;
                            task_names: string[];
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            config_path: string;
                            result_path: string | null;
                            command: string[];
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
                /** @description Default Response */
                503: {
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
    "/api/v1/workbench/local-runs/{local_run_id}": {
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
                    local_run_id: string;
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
                            local_run_id: string;
                            recipe_digest: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
                            benchmark: string;
                            model: string;
                            task_names: string[];
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            config_path: string;
                            result_path: string | null;
                            command: string[];
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
    "/api/v1/workbench/local-runs/{local_run_id}/logs": {
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
                    local_run_id: string;
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
                            stdout: string;
                            stderr: string;
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
    "/api/v1/workbench/local-runs/{local_run_id}/cancel": {
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
                    local_run_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
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
                            local_run_id: string;
                            recipe_digest: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
                            benchmark: string;
                            model: string;
                            task_names: string[];
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            config_path: string;
                            result_path: string | null;
                            command: string[];
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
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workbench/setup-tests": {
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
                            setup_test_id: string;
                            recipe_digest: string;
                            revision_id: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "passed" | "failed" | "timed-out";
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            files: {
                                file_id: string;
                                path: string;
                                /** @enum {unknown} */
                                root: "workspace" | "logs";
                                size: number;
                                text: boolean;
                            }[];
                        }[];
                    };
                };
                /** @description Default Response */
                503: {
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
                        /** Agent Workbench recipe v1 */
                        recipe: {
                            /** @enum {unknown} */
                            schema_version: "v1";
                            name: string;
                            setup_command: string;
                            run_command: string;
                            /** @enum {unknown} */
                            route_api: "chat-completions" | "responses";
                            setup_timeout_seconds: number;
                            environment: {
                                name: string;
                                /** @enum {unknown} */
                                source: "literal" | "instruction_path" | "workspace_path" | "logs_path" | "agent_home" | "model_name" | "model_base_url" | "model_api_key";
                                value?: string;
                            }[];
                            outputs: {
                                results_path: string;
                                trajectory_path: null | string;
                            };
                        };
                        /** @enum {unknown} */
                        confirmed: true;
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
                            setup_test_id: string;
                            recipe_digest: string;
                            revision_id: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "passed" | "failed" | "timed-out";
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            files: {
                                file_id: string;
                                path: string;
                                /** @enum {unknown} */
                                root: "workspace" | "logs";
                                size: number;
                                text: boolean;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                503: {
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
    "/api/v1/workbench/setup-tests/{setup_test_id}": {
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
                    setup_test_id: string;
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
                            setup_test_id: string;
                            recipe_digest: string;
                            revision_id: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "passed" | "failed" | "timed-out";
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            files: {
                                file_id: string;
                                path: string;
                                /** @enum {unknown} */
                                root: "workspace" | "logs";
                                size: number;
                                text: boolean;
                            }[];
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
                /** @description Default Response */
                503: {
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
    "/api/v1/workbench/setup-tests/{setup_test_id}/cancel": {
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
                    setup_test_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
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
                            setup_test_id: string;
                            recipe_digest: string;
                            revision_id: string;
                            /** @enum {unknown} */
                            status: "queued" | "running" | "cancelling" | "cancelled" | "passed" | "failed" | "timed-out";
                            /** Format: date-time */
                            created_at: string;
                            started_at: string | null;
                            completed_at: string | null;
                            exit_code: number | null;
                            error: string | null;
                            files: {
                                file_id: string;
                                path: string;
                                /** @enum {unknown} */
                                root: "workspace" | "logs";
                                size: number;
                                text: boolean;
                            }[];
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
                /** @description Default Response */
                503: {
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
    "/api/v1/workbench/setup-tests/{setup_test_id}/logs": {
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
                    setup_test_id: string;
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
                            stdout: string;
                            stderr: string;
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
    "/api/v1/workbench/setup-tests/{setup_test_id}/files/{file_id}": {
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
                    setup_test_id: string;
                    file_id: string;
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
                            content: string;
                            truncated: boolean;
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
    "/api/v1/runs": {
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
                                run_id: string;
                                /** Format: date-time */
                                created_at: string;
                                status: string;
                                ceiling_microusd: number;
                                reserved_microusd: number;
                                observed_microusd: number;
                                budget_exceeded: boolean;
                                total_tasks: number;
                                terminal_tasks: number;
                                admissible_tasks: number;
                                invalid_selected_tasks: number;
                                exhausted_tasks: number;
                                successful_tasks: number;
                                pending_actions: number;
                                replacement_assigned_tasks: number;
                                replacement_recorded_tasks: number;
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
                        benchmark?: string;
                        model?: string;
                        harness: string | {
                            /** @enum {unknown} */
                            type: "workbench";
                            recipe: {
                                [key: string]: unknown;
                            };
                            setup_test_id: string;
                        };
                        deployment?: string | null;
                        launch_policy?: string;
                        benchmark_config?: string;
                        benchmark_config_revision?: string;
                        ceiling_microusd: number;
                        confirmed: boolean;
                        /** @default false */
                        start_paused?: boolean;
                    } & ({
                        benchmark: string;
                        model: string;
                        harness?: string;
                        launch_policy: string;
                        benchmark_config?: never;
                        benchmark_config_revision?: never;
                    } | {
                        benchmark_config: string;
                        benchmark_config_revision: string;
                        harness?: {
                            /** @enum {unknown} */
                            type: "workbench";
                            recipe: {
                                [key: string]: unknown;
                            };
                            setup_test_id: string;
                        };
                        benchmark?: never;
                        model?: never;
                        deployment?: never;
                        launch_policy?: never;
                    });
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
                            run_id: string;
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
    "/api/v1/runs/{run_id}/continuation": {
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
                    run_id: string;
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
                    run_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        reason: string;
                        /** @enum {unknown} */
                        confirmed: true;
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
                            run_id: string;
                            continuation_id: string;
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
    "/api/v1/runs/{run_id}/continuation-repair": {
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
                    run_id: string;
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
                    run_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        reason: string;
                        /** @enum {unknown} */
                        confirmed: true;
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
                            run_id: string;
                            continuation_repair_id: string;
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
    "/api/v1/runs/{run_id}/continuation-repair-successor": {
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
                    run_id: string;
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
                    run_id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        reason: string;
                        /** @enum {unknown} */
                        confirmed: true;
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
                            run_id: string;
                            continuation_repair_successor_id: string;
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
    "/api/v1/runs/{run_id}": {
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
                    run_id: string;
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
                            run_id: string;
                            /** Format: date-time */
                            created_at: string;
                            status: string;
                            ceiling_microusd: number;
                            reserved_microusd: number;
                            observed_microusd: number;
                            budget_exceeded: boolean;
                            total_tasks: number;
                            terminal_tasks: number;
                            admissible_tasks: number;
                            invalid_selected_tasks: number;
                            exhausted_tasks: number;
                            successful_tasks: number;
                            pending_actions: number;
                            replacement_assigned_tasks: number;
                            replacement_recorded_tasks: number;
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
    "/api/v1/runs/{run_id}/capacity": {
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
                    run_id: string;
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
                            run_limit: number;
                            run_active: number;
                            hardware_limit: number | null;
                            hardware_active: number;
                            provider_limit: number;
                            provider_reserved: number;
                            start_tokens: number | null;
                            start_burst: number | null;
                            queued: number;
                            limiting_factor: ("run_job_capacity" | "namespace_job_capacity" | "hardware_job_capacity" | "provider_request_capacity" | "start_rate" | "run_cancelled") | null;
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
    "/api/v1/runs/{run_id}/lock": {
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
                    run_id: string;
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
    "/api/v1/runs/{run_id}/prepared-job": {
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
                    run_id: string;
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
                    run_id: string;
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
                        trial_lock_digest: string;
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
    "/api/v1/runs/{run_id}/prepared-job/trials/{task_id}": {
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
                    run_id: string;
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
    "/api/v1/runs/{run_id}/tasks": {
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
                    run_id: string;
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
                                run_id: string;
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
    "/api/v1/runs/{run_id}/tasks/{task_id}": {
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
                    run_id: string;
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
                                run_id: string;
                                task_id: string;
                                input_digest: string;
                                terminal_outcome: string | null;
                                selected_attempt_id: string | null;
                            };
                            attempts: {
                                attempt_id: string;
                                action_id: string;
                                run_id: string;
                                task_id: string;
                                outcome: string;
                                replacement_eligible: number;
                                failure_fingerprint: string | null;
                                cost_microusd: number;
                                metrics: {
                                    [key: string]: number;
                                };
                                /** Format: date-time */
                                created_at: string;
                                physical_job: null | {
                                    resource_id: string | null;
                                    observed_state: string | null;
                                    inspect_url: string | null;
                                };
                            }[];
                            exhaustion: null | {
                                source_action_id: string;
                                last_attempt_id: string | null;
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
    "/api/v1/runs/{run_id}/actions": {
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
                    run_id: string;
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
                            run_id: string;
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
    "/api/v1/runs/{run_id}/tasks/{task_id}/attempts": {
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
                    run_id: string;
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
                        failure_fingerprint?: string;
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
                            run_id: string;
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
        /** @description Lists Jobs globally with offset pagination. When run_id is present, returns every latest Job for that Run in one stable response with next_cursor set to null. */
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    /** @description Return every latest Job for this Run in one response. cursor and limit do not apply. */
                    run_id?: string;
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
                                run_id: string;
                                action_kind: string;
                                generation: number;
                                target: string;
                                outcome: string | null;
                                observed_state: string | null;
                                resource_id: string | null;
                                /** Format: date-time */
                                created_at: string;
                                /** @enum {string} */
                                readonly worker_role: "preparation" | "execution";
                                launch_action_id: string;
                                inspect_url: string | null;
                                cost_microusd: number;
                                assigned_tasks: number;
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
                                run_id: string;
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
    "/api/v1/leaderboard/candidates": {
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
                            items: {
                                run_id: string;
                                publication_id: string;
                                catalog_digest: string;
                                public_row: {
                                    configuration_digest: string;
                                    run_id: string;
                                    publication_id: string;
                                    /** Format: date-time */
                                    published_at: string;
                                    benchmark: string;
                                    model: string;
                                    harness: string;
                                    inference_provider: string;
                                    reasoning_effort: string;
                                    harbor_version: string;
                                    trial_count: number;
                                    task_count: number;
                                    scored_task_count: number;
                                    primary_metric_name: string;
                                    primary_metric_value: number;
                                    primary_metric_unit: string;
                                    observed_microusd: number;
                                };
                            }[];
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
    "/api/v1/leaderboard/submissions": {
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
                            items: {
                                id: string;
                                run_id: string;
                                publication_id: string;
                                catalog_digest: string;
                                /** Format: date-time */
                                created_at: string;
                                /** @enum {unknown} */
                                status: "pending" | "approved" | "rejected";
                            }[];
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
                        run_id: string;
                        catalog_digest: string;
                        /** @enum {boolean} */
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
                            id: string;
                            run_id: string;
                            publication_id: string;
                            catalog_digest: string;
                            /** Format: date-time */
                            created_at: string;
                            /** @enum {unknown} */
                            status: "pending" | "approved" | "rejected";
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
    "/api/v1/leaderboard/submissions/{id}/review": {
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
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {unknown} */
                        decision: "approved" | "rejected";
                        /** @enum {boolean} */
                        confirmed: true;
                        /** @description Required true for approval: operator verified privacy and consent for every exact public row field. */
                        public_metadata_confirmed?: boolean;
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
                            id: string;
                            /** @enum {unknown} */
                            status: "pending" | "approved" | "rejected";
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
    "/api/v1/leaderboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Official snapshot rows. Anonymous GET is allowed. Runs and result details stay authenticated. */
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
                            snapshot: {
                                record_id: string;
                                /** Format: date-time */
                                created_at: string;
                                sqlite_digest: string;
                                source_digest: string;
                                entry_count: number;
                            } | null;
                            items: {
                                rank: number;
                                pareto: boolean;
                                configuration_digest: string;
                                run_id: string;
                                publication_id: string;
                                /** Format: date-time */
                                published_at: string;
                                benchmark: string;
                                model: string;
                                harness: string;
                                inference_provider: string;
                                reasoning_effort: string;
                                harbor_version: string;
                                trial_count: number;
                                task_count: number;
                                scored_task_count: number;
                                primary_metric_name: string;
                                primary_metric_value: number;
                                primary_metric_unit: string;
                                observed_microusd: number;
                            }[];
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
                                run_id: string;
                                status: string;
                                catalog_digest: string | null;
                                /** Format: date-time */
                                published_at: string;
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
                            run_id: string;
                            status: string;
                            catalog_digest: string | null;
                            /** Format: date-time */
                            published_at: string;
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
        /** @description Streams bounded durable-event replay and live updates. cursor.reset tells clients to refetch current state and resume from data.latest_cursor. */
        get: {
            parameters: {
                query?: {
                    /** @description Last durable cursor received. Replay is capped; stale cursors receive cursor.reset. */
                    cursor?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Server-Sent Events frames. Durable envelopes have an id. cursor.reset has no id and includes reason, latest_cursor, and replay_limit metadata. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/event-stream": string;
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
