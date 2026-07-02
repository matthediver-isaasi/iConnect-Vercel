<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_Block {

    public function __construct() {
        add_action( 'init', array( $this, 'register_block' ) );
    }

    public function register_block() {
        if ( ! function_exists( 'register_block_type' ) ) {
            return;
        }

        wp_register_script(
            'iconnect-sync-block-editor',
            ICONNECT_SYNC_PLUGIN_URL . 'blocks/articles/index.js',
            array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-server-side-render', 'wp-i18n' ),
            ICONNECT_SYNC_VERSION,
            true
        );

        wp_register_style(
            'iconnect-sync-block-editor-style',
            ICONNECT_SYNC_PLUGIN_URL . 'blocks/articles/editor.css',
            array(),
            ICONNECT_SYNC_VERSION
        );

        register_block_type( 'iconnect-sync/articles', array(
            'editor_script'   => 'iconnect-sync-block-editor',
            'editor_style'    => 'iconnect-sync-block-editor-style',
            'render_callback' => array( $this, 'render_block' ),
            'attributes'      => array(
                'limit'    => array(
                    'type'    => 'number',
                    'default' => 6,
                ),
                'category' => array(
                    'type'    => 'string',
                    'default' => '',
                ),
                'layout'   => array(
                    'type'    => 'string',
                    'default' => 'grid',
                ),
            ),
        ) );
    }

    public function render_block( $attributes ) {
        $shortcode = new IConnect_Sync_Shortcode();
        return $shortcode->render_shortcode( array(
            'limit'    => isset( $attributes['limit'] ) ? $attributes['limit'] : 6,
            'category' => isset( $attributes['category'] ) ? $attributes['category'] : '',
            'layout'   => isset( $attributes['layout'] ) ? $attributes['layout'] : 'grid',
        ) );
    }
}
