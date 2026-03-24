<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_Webhook {

    public function __construct() {
        add_action( 'rest_api_init', array( $this, 'register_routes' ) );
    }

    public function register_routes() {
        register_rest_route( 'iconnect-sync/v1', '/webhook', array(
            'methods'             => 'POST',
            'callback'            => array( $this, 'handle_webhook' ),
            'permission_callback' => array( $this, 'validate_request' ),
        ) );
    }

    public function validate_request( WP_REST_Request $request ) {
        $api_key = get_option( 'iconnect_sync_api_key', '' );

        if ( empty( $api_key ) ) {
            return true;
        }

        $provided_key = $request->get_header( 'X-IConnect-API-Key' );

        if ( empty( $provided_key ) ) {
            $provided_key = $request->get_header( 'Authorization' );
            if ( $provided_key && strpos( $provided_key, 'Bearer ' ) === 0 ) {
                $provided_key = substr( $provided_key, 7 );
            }
        }

        if ( empty( $provided_key ) || ! hash_equals( $api_key, $provided_key ) ) {
            return new WP_Error(
                'rest_forbidden',
                __( 'Invalid API key.', 'iconnect-sync' ),
                array( 'status' => 403 )
            );
        }

        return true;
    }

    public function handle_webhook( WP_REST_Request $request ) {
        $engine = new IConnect_Sync_Engine();
        $result = $engine->run_sync();

        if ( is_wp_error( $result ) ) {
            return new WP_REST_Response( array(
                'success' => false,
                'message' => $result->get_error_message(),
            ), 500 );
        }

        return new WP_REST_Response( array(
            'success' => true,
            'message' => 'Sync completed successfully.',
            'data'    => array(
                'created' => $result['created'],
                'updated' => $result['updated'],
                'trashed' => $result['trashed'],
            ),
        ), 200 );
    }
}
