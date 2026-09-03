export interface paths {
    "/api/v1/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the current session */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
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
        /** Read system state */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/presets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List benchmark and agent presets */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
                            trajectory_path: string | null;
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
                                trajectory_path: string | null;
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
                                trajectory_path: string | null;
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
                                trajectory_path: string | null;
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
        /** List runs */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        /** Submit a preset run */
        post: {
            parameters: {
                query?: never;
                header: {
                    "Idempotency-Key": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PresetSubmission"];
                };
            };
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Success */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                        };
                    };
                };
                /** @description Request error */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/runs/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit a direct Harbor JobConfig */
        post: {
            parameters: {
                query?: never;
                header: {
                    "Idempotency-Key": string;
                    "X-Harbor-HF-Cost-Ceiling-USD-Per-Trial": number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": Record<string, never>;
                };
            };
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Success */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                        };
                    };
                };
                /** @description Request error */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one run */
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
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/runs/{run_id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pause a run */
        post: {
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
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/runs/{run_id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume a run */
        post: {
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
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                        };
                    };
                };
                /** @description Request error */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/runs/{run_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel a run */
        post: {
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
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/runs/{run_id}/trials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List trials for one run */
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
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/runs/{run_id}/trials/{trial_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one trial result */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    run_id: string;
                    trial_name: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List parent Jobs */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };
                /** @description Request error */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
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
    "/api/v1/leaderboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the public leaderboard */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
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
    schemas: {
        PresetSubmission: {
            benchmark: {
                name: string;
                preset: string;
            };
            model: {
                id: string;
                provider: string;
                reasoning_effort: string;
            };
            harness: {
                agent: string;
                version: string;
            };
            cost_ceiling_usd_per_trial: number;
            /**
             * @default final
             * @enum {string}
             */
            role: "final" | "diagnostic";
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
