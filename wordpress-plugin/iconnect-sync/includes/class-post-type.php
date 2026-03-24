<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_Post_Type {

    public function __construct() {
        add_action( 'init', array( $this, 'register_post_type' ) );
        add_action( 'init', array( $this, 'register_taxonomy' ) );
    }

    public function register_post_type() {
        $labels = array(
            'name'               => __( 'iConnect Articles', 'iconnect-sync' ),
            'singular_name'      => __( 'iConnect Article', 'iconnect-sync' ),
            'menu_name'          => __( 'iConnect Articles', 'iconnect-sync' ),
            'all_items'          => __( 'All Articles', 'iconnect-sync' ),
            'view_item'          => __( 'View Article', 'iconnect-sync' ),
            'search_items'       => __( 'Search Articles', 'iconnect-sync' ),
            'not_found'          => __( 'No articles found', 'iconnect-sync' ),
            'not_found_in_trash' => __( 'No articles found in Trash', 'iconnect-sync' ),
        );

        $args = array(
            'labels'              => $labels,
            'public'              => true,
            'publicly_queryable'  => true,
            'show_ui'             => true,
            'show_in_menu'        => true,
            'show_in_rest'        => true,
            'menu_icon'           => 'dashicons-rss',
            'query_var'           => true,
            'rewrite'             => array( 'slug' => 'iconnect-articles' ),
            'capability_type'     => 'post',
            'has_archive'         => true,
            'hierarchical'        => false,
            'supports'            => array( 'title', 'excerpt', 'thumbnail', 'custom-fields' ),
            'capabilities'        => array(
                'create_posts' => 'do_not_allow',
            ),
            'map_meta_cap'        => true,
        );

        register_post_type( 'iconnect_article', $args );
    }

    public function register_taxonomy() {
        $labels = array(
            'name'          => __( 'iConnect Tags', 'iconnect-sync' ),
            'singular_name' => __( 'iConnect Tag', 'iconnect-sync' ),
            'search_items'  => __( 'Search Tags', 'iconnect-sync' ),
            'all_items'     => __( 'All Tags', 'iconnect-sync' ),
            'edit_item'     => __( 'Edit Tag', 'iconnect-sync' ),
            'update_item'   => __( 'Update Tag', 'iconnect-sync' ),
            'add_new_item'  => __( 'Add New Tag', 'iconnect-sync' ),
            'new_item_name' => __( 'New Tag Name', 'iconnect-sync' ),
            'menu_name'     => __( 'Tags', 'iconnect-sync' ),
        );

        register_taxonomy( 'iconnect_tag', 'iconnect_article', array(
            'labels'            => $labels,
            'hierarchical'      => false,
            'public'            => true,
            'show_in_rest'      => true,
            'show_admin_column' => true,
            'rewrite'           => array( 'slug' => 'iconnect-tag' ),
        ) );
    }
}
